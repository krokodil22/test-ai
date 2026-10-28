#!/usr/bin/env python3
"""Development-only, offline CPU reference; never runs in the website."""
import os
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")
import argparse
import json
import platform
import inspect
import time
from datetime import datetime, timezone
from pathlib import Path
import torch
import transformers
from transformers import AutoModelForCausalLM, AutoModelForImageTextToText, AutoTokenizer, GenerationConfig

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--model")
parser.add_argument("--output", default=str(root / "public/diagnostics/model-reference.json"))
parser.add_argument("--profile", default=str(root / "scripts/reference-source.json"))
parser.add_argument("--cases", default=str(root / "src/diagnostic-cases.json"))
parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
parser.add_argument("--dtype", choices=["float32", "bfloat16"])
parser.add_argument("--audit-embedding-tie", action="store_true")
parser.add_argument("--orthrus-native-ar", action="store_true")
args = parser.parse_args()
profile = json.loads(Path(args.cases).read_text())
source = json.loads(Path(args.profile).read_text())
args.model = args.model or str(root / ".cache/reference" / source.get("directory", source["repository"].split("/")[-1].lower()))
args.dtype = args.dtype or source.get("dtype", "float32")
torch.set_num_threads(args.threads)
torch.manual_seed(profile["settings"]["seed"])
print("Loading", source["repository"], "on CPU,", args.dtype, "offline", flush=True)
tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True, trust_remote_code=False)
model_config = json.loads((Path(args.model) / "config.json").read_text())
model_class = AutoModelForImageTextToText if model_config.get("model_type") in ["qwen3_5", "gemma3"] else AutoModelForCausalLM
dtype = torch.float32 if args.dtype == "float32" else torch.bfloat16
model, loading_info = model_class.from_pretrained(args.model, torch_dtype=dtype, attn_implementation="eager", local_files_only=True, trust_remote_code=False, output_loading_info=True)
ar_variant = None
if args.orthrus_native_ar:
    from reference_orthrus_ar import validate_native_ar_load, compare_original_ar_logits
    ar_variant = validate_native_ar_load(model_config, loading_info)
    loading_info["unexpected_keys"] = []  # Only the exact, audited auxiliary set was accepted.
if any(loading_info.get(key) for key in ["missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"]):
    raise RuntimeError("Checkpoint differs from the native model implementation: " + json.dumps(loading_info, default=lambda value: sorted(value) if isinstance(value, set) else str(value)))
model = model.eval()
if any(parameter.is_floating_point() and parameter.dtype != dtype for parameter in model.parameters()):
    raise RuntimeError("Reference weights must match the declared dtype")
eos_ids = model.generation_config.eos_token_id or tokenizer.eos_token_id
eos_ids = eos_ids if isinstance(eos_ids, list) else [eos_ids]
eos_ids = list(dict.fromkeys([*eos_ids, tokenizer.eos_token_id]))
pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos_ids[0]
results = []
report = dict(schema=1, kind="cpu-reference", protocol=profile["protocol"], generatedAt=datetime.now(timezone.utc).isoformat(), model=source["repository"], revision=source["revision"], engine=f"Transformers {transformers.__version__}", torch=torch.__version__, python=platform.python_version(), device="CPU", dtype=args.dtype, quantization="none", systemPrompt=profile["systemPrompt"], settings=profile["settings"], comparable="Same prompts and declared settings; different weights format and precision. Texts need human review, not exact equality.", results=results, complete=False)
if ar_variant:
    report["variant"] = ar_variant
    report["variant"]["logitEquivalence"] = compare_original_ar_logits(Path(args.model), model, tokenizer, dtype)
    print("Audited AR variant:", json.dumps(report["variant"]), flush=True)
if args.audit_embedding_tie:
    from reference_embedding_audit import audit_embeddings
    report["embeddingAudit"] = audit_embeddings(Path(args.model), model)
    print("Embedding audit:", json.dumps(report["embeddingAudit"]), flush=True)
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
partial = root / ".cache/reference" / (output.stem + ".partial.json")
partial.parent.mkdir(parents=True, exist_ok=True)
for case in profile["cases"]:
    # Gemma's published chat template has no system role; keep the instruction
    # verbatim at the start of the first user turn, and disclose this adaptation.
    if model_config.get("model_type", "").startswith("gemma"):
        messages = [dict(role="user", content=profile["systemPrompt"] + "\n\n" + case["prompt"])]
        report["systemPlacement"] = "prepended to first user message (Gemma template)"
    else:
        messages = [dict(role="system", content=profile["systemPrompt"]), dict(role="user", content=case["prompt"])]
    encoded = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=profile["settings"].get("enableThinking", False), return_tensors="pt")
    if not isinstance(encoded, torch.Tensor):
        encoded = encoded["input_ids"]
    sampling = profile["settings"]["temperature"] > 0
    penalty = profile["settings"].get("repetitionPenalty", 1.0)
    torch.manual_seed(profile["settings"]["seed"])
    config = GenerationConfig(do_sample=sampling, temperature=profile["settings"]["temperature"] if sampling else 1.0, top_p=profile["settings"]["topP"], top_k=0, repetition_penalty=penalty, max_new_tokens=case["maxTokens"], eos_token_id=eos_ids, pad_token_id=pad_id, bos_token_id=tokenizer.bos_token_id)
    # Transformers 4.51 backfills model sampling defaults unless explicitly
    # disabled; 5.x removed that option and prioritizes the supplied config.
    defaults = {"use_model_defaults": False} if "use_model_defaults" in inspect.signature(model._prepare_generation_config).parameters else {}
    effective, _ = model._prepare_generation_config(config, **defaults)
    if effective.do_sample != sampling or effective.top_p != profile["settings"]["topP"] or effective.repetition_penalty != penalty:
        raise RuntimeError("Reference sampling differs from the requested settings")
    start = time.perf_counter()
    with torch.inference_mode():
        generated = model.generate(encoded, attention_mask=torch.ones_like(encoded), generation_config=config, **defaults)
    seconds = time.perf_counter() - start
    tokens = generated[0, encoded.shape[-1]:].tolist()
    text = tokenizer.decode(tokens, skip_special_tokens=True).strip()
    results.append(dict(caseId=case["id"], prompt=case["prompt"], maxTokens=case["maxTokens"], text=text, finish="complete" if tokens and tokens[-1] in eos_ids else "length", seconds=seconds, generatedTokens=len(tokens), inputTokens=encoded[0].tolist()))
    print(case["id"], f"{seconds:.1f}s", repr(text), flush=True)
    partial.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
report["complete"] = True
temporary = output.with_suffix(".json.tmp")
temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
temporary.replace(output)
print("Saved CPU reference:", output, flush=True)
