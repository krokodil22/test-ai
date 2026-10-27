#!/usr/bin/env python3
"""Development-only, offline FP32/CPU reference; never runs in the website."""
import os
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")
import argparse
import json
import platform
import time
from datetime import datetime, timezone
from pathlib import Path
import torch
import transformers
from transformers import AutoModelForCausalLM, AutoTokenizer, GenerationConfig

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--model", default=str(root / ".cache/reference/qwen3-1.7b"))
parser.add_argument("--output", default=str(root / "public/diagnostics/qwen3-reference.json"))
args = parser.parse_args()
profile = json.loads((root / "src/diagnostic-cases.json").read_text())
source = json.loads((root / "scripts/reference-source.json").read_text())
torch.set_num_threads(min(4, os.cpu_count() or 1))
torch.manual_seed(profile["settings"]["seed"])
print("Loading original Qwen3 weights on CPU, FP32, offline", flush=True)
tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.float32, attn_implementation="eager", local_files_only=True).eval()
results = []
report = dict(schema=1, kind="cpu-reference", protocol=profile["protocol"], generatedAt=datetime.now(timezone.utc).isoformat(), model=source["repository"], revision=source["revision"], engine=f"Transformers {transformers.__version__}", torch=torch.__version__, python=platform.python_version(), device="CPU", dtype="float32", quantization="none", systemPrompt=profile["systemPrompt"], settings=profile["settings"], comparable="Same base model, prompts and greedy decoding; different weights format and precision. Texts need human review, not exact equality.", results=results, complete=False)
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
partial = root / ".cache/reference/run.partial.json"
partial.parent.mkdir(parents=True, exist_ok=True)
for case in profile["cases"]:
    messages = [dict(role="system", content=profile["systemPrompt"]), dict(role="user", content=case["prompt"])]
    encoded = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False, return_tensors="pt")
    config = GenerationConfig(do_sample=False, temperature=1.0, top_p=1.0, top_k=0, repetition_penalty=1.0, max_new_tokens=case["maxTokens"], eos_token_id=[151643, 151645], pad_token_id=151643, bos_token_id=151643)
    effective, _ = model._prepare_generation_config(config, use_model_defaults=False)
    if effective.do_sample or effective.top_p != 1.0 or effective.repetition_penalty != 1.0:
        raise RuntimeError("CPU reference must use greedy decoding without model-default sampling")
    start = time.perf_counter()
    with torch.inference_mode():
        generated = model.generate(encoded, attention_mask=torch.ones_like(encoded), generation_config=config, use_model_defaults=False)
    seconds = time.perf_counter() - start
    tokens = generated[0, encoded.shape[-1]:].tolist()
    text = tokenizer.decode(tokens, skip_special_tokens=True).strip()
    results.append(dict(caseId=case["id"], prompt=case["prompt"], maxTokens=case["maxTokens"], text=text, finish="complete" if tokens and tokens[-1] in [151643, 151645] else "length", seconds=seconds, generatedTokens=len(tokens), inputTokens=encoded[0].tolist()))
    print(case["id"], f"{seconds:.1f}s", repr(text), flush=True)
    partial.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
report["complete"] = True
temporary = output.with_suffix(".json.tmp")
temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
temporary.replace(output)
print("Saved CPU reference:", output, flush=True)
