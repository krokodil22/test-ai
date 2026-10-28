"""Audited, development-only check of Orthrus's explicitly supported AR branch.

The source snapshot is read and hash checked before importing the reviewed model
definition. No repository-supplied Python is imported by the deployed website.
"""
import hashlib
import importlib.util
import json
import tempfile
from pathlib import Path

SOURCE_SHA256 = "7e8f4e01c4c8c469866839976acd6fa45dec207af40d939e0a46b8918e413334"


def validate_native_ar_load(config, loading):
    if config.get("architectures") != ["OrthrusLM"] or config.get("model_type") != "qwen3" or config.get("num_hidden_layers") != 28:
        raise ValueError("The AR extraction was reviewed only for the pinned Orthrus 0.6B architecture")
    expected = {f"model.layers.{layer}.self_attn.{kind}_diff.weight" for layer in range(28) for kind in ["q_proj", "k_proj", "v_proj", "o_proj", "q_norm", "k_norm"]}
    if set(loading.get("unexpected_keys", [])) != expected or any(loading.get(key) for key in ["missing_keys", "mismatched_keys", "error_msgs"]):
        raise ValueError("The checkpoint differs from the exact native AR parameters plus the audited diffusion-only branches")
    return dict(name="native Qwen3 autoregressive subnetwork", excludedAuxiliaryTensorCount=len(expected), excludedAuxiliaryTensors=sorted(expected), architectureSourceSha256=SOURCE_SHA256, note="Ordinary AR mode only; full hybrid/diffusion behavior and its acceleration are not included.")


def compare_original_ar_logits(directory, native, tokenizer, dtype):
    import torch
    root = Path(__file__).resolve().parent.parent
    snapshot = json.loads((root / "docs/model-evaluation/zarya-source-review.json").read_text())
    source = next(file for file in snapshot["files"] if file["path"] == "modeling_orthrus.py")
    if hashlib.sha256(source["text"].encode()).hexdigest() != SOURCE_SHA256 or source["sha256"] != SOURCE_SHA256:
        raise ValueError("Custom model source changed after the read-only review")
    # The reviewed source imports only typing, torch and Transformers. Its AR
    # attention calls Qwen3Attention.forward directly; generate(...,
    # use_diffusion_mode=False) delegates to standard GenerationMixin.
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "reviewed_orthrus.py"
        path.write_text(source["text"])
        spec = importlib.util.spec_from_file_location("reviewed_orthrus", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original, info = module.OrthrusLM.from_pretrained(directory, dtype=dtype, attn_implementation="eager", local_files_only=True, output_loading_info=True)
        if any(info.get(key) for key in ["missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"]):
            raise ValueError("The full reviewed model did not load exactly")
        original.eval()
        results = []
        for prompt in ["Сколько будет 2 + 2? Ответь только числом.", "Как приготовить омлет из двух яиц? Дай короткий список шагов."]:
            encoded = tokenizer.apply_chat_template([dict(role="system", content="You are a helpful assistant."), dict(role="user", content=prompt)], tokenize=True, add_generation_prompt=True, enable_thinking=False, return_tensors="pt")
            if not isinstance(encoded, torch.Tensor):
                encoded = encoded["input_ids"]
            with torch.inference_mode():
                a = original(input_ids=encoded, use_cache=True, is_diffusion_pass=False)
                b = native(input_ids=encoded, use_cache=True)
                prefill_error = (a.logits - b.logits).abs().max().item()
                torch.testing.assert_close(a.logits, b.logits, atol=1e-5, rtol=1e-5)
                token = b.logits[:, -1].argmax(-1, keepdim=True)
                next_a = original(input_ids=token, past_key_values=a.past_key_values, use_cache=True, is_diffusion_pass=False)
                next_b = native(input_ids=token, past_key_values=b.past_key_values, use_cache=True)
                decode_error = (next_a.logits - next_b.logits).abs().max().item()
                torch.testing.assert_close(next_a.logits, next_b.logits, atol=1e-5, rtol=1e-5)
            results.append(dict(prompt=prompt, prefillMaxAbsoluteError=prefill_error, decodeMaxAbsoluteError=decode_error, firstTokenId=token.item()))
        del original
    return dict(verified=True, dtype=str(dtype), results=results, checks="All vocabulary logits after prefill and after one cached decode step; original explicit AR branch versus native Qwen3, same checkpoint weights.")
