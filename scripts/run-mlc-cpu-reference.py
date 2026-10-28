#!/usr/bin/env python3
"""Development-only Qwen2.5 check with local MLC Q4 weights, not original FP32 weights.

Reconstructs the pinned q4f16_1 tensors and executes the independent Transformers
Qwen2 implementation on CPU. No Python code or reconstructed weights enter the site.
"""
import os

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")

import argparse
import gzip
import hashlib
import json
import platform
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def dequantize_q4f16_1(packed, scales):
    """MLC NK layout: eight little-endian nibbles per uint32, group 32, zero 7.

    Round the reconstructed product to FP16, as the MLC dequantization operator
    does, before moving it to the independent CPU model's FP32 computation.
    """
    if packed.dtype != np.dtype("uint32") or packed.ndim != 2 or scales.dtype != np.dtype("float16") or scales.shape != (packed.shape[0], packed.shape[1] // 4) or packed.shape[1] % 4:
        raise ValueError("Expected q4f16_1 NK tensors with group size 32")
    shifts = np.arange(8, dtype=np.uint32) * 4
    codes = ((packed[:, :, None] >> shifts) & 15).reshape(packed.shape[0], -1).astype(np.float16)
    return ((codes - np.float16(7)) * np.repeat(scales, 32, axis=1)).astype(np.float32)


def verify_resources(base, source):
    info = json.loads((base / "model-info.json").read_text())
    if info["modelId"] != source["modelId"] or info["revision"] != source["revision"]:
        raise ValueError("Local resources do not match the pinned light-model profile")
    pinned = {"model.wasm": source["runtime"]}
    for file in source["files"]:
        path = source["cacheManifest"] if file["path"] == source.get("upstreamCacheManifest") else file["path"]
        pinned["resolve/main/" + path] = file
    if {item["path"] for item in info["files"]} != set(pinned):
        raise ValueError("Unexpected files in the local resource manifest")
    for item in info["files"]:
        expected = pinned[item["path"]]
        if (item["bytes"], item["sha256"]) != (expected["bytes"], expected["sha256"]):
            raise ValueError("Resource manifest differs from the pinned source integrity")
        packed = item.get("download", item)
        path = (base / packed["path"]).resolve()
        if not path.is_relative_to(base):
            raise ValueError("Unsafe resource path")
        data = path.read_bytes()
        if len(data) != packed["bytes"] or hashlib.sha256(data).hexdigest() != packed["sha256"]:
            raise ValueError(f"Resource integrity mismatch: {item['path']}")
        if "download" in item:
            data = gzip.decompress(data)
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError(f"Expanded resource integrity mismatch: {item['path']}")
    return info


def load_tensors(base, manifest_name):
    manifest = json.loads((base / "resolve/main" / manifest_name).read_text())
    tensors = {}
    for shard in manifest["records"]:
        path = base / "resolve/main" / shard["dataPath"]
        data = path.read_bytes() if path.exists() else gzip.decompress(path.with_suffix(path.suffix + ".gz").read_bytes())
        for record in shard["records"]:
            dtype = np.dtype(record["dtype"])
            if dtype not in (np.dtype("uint32"), np.dtype("float16")):
                raise ValueError("This checker supports only the pinned Q4F16 tensors")
            count = int(np.prod(record["shape"]))
            if count * dtype.itemsize != record["nbytes"]:
                raise ValueError("Unexpected tensor byte size")
            tensors[record["name"]] = np.frombuffer(data, dtype=dtype, count=count, offset=record["byteOffset"]).reshape(record["shape"]).copy()
    return tensors


def reconstruct_model(tensors, config):
    import torch
    from transformers import Qwen2Config, Qwen2ForCausalLM

    model_config = config["model_config"]
    hf_config = Qwen2Config(**{key: model_config[key] for key in ["hidden_act", "hidden_size", "intermediate_size", "num_attention_heads", "num_hidden_layers", "num_key_value_heads", "rms_norm_eps", "rope_theta", "vocab_size", "tie_word_embeddings"]}, max_position_embeddings=model_config["context_window_size"], use_cache=True)
    hf_config._attn_implementation = "eager"
    # Keep non-persistent RoPE buffers on CPU too. They are computed by the
    # canonical implementation and do not occur in the serialized tensor list.
    with torch.device("cpu"):
        model = Qwen2ForCausalLM(hf_config)
    state = {}
    used = set()
    for name, tensor in tensors.items():
        if name in used or name.endswith(".q_scale"):
            continue
        if name.endswith(".q_weight"):
            scale_name = name.removesuffix(".q_weight") + ".q_scale"
            tensor = dequantize_q4f16_1(tensor, tensors[scale_name])
            used.add(scale_name)
            target = name.removesuffix(".q_weight") + ".weight"
        else:
            tensor = tensor.astype(np.float32)
            target = name
        used.add(name)
        if ".self_attn.c_attn." in target:
            q = model_config["num_attention_heads"] * model_config["head_dim"]
            kv = model_config["num_key_value_heads"] * model_config["head_dim"]
            if tensor.shape[0] != q + 2 * kv:
                raise ValueError("Unexpected fused Q/K/V shape")
            for key, part in zip(["q_proj", "k_proj", "v_proj"], np.split(tensor, [q, q + kv], axis=0)):
                state[target.replace("c_attn", key)] = torch.from_numpy(part)
        elif ".mlp.gate_up_proj." in target:
            for key, part in zip(["gate_proj", "up_proj"], np.split(tensor, 2, axis=0)):
                state[target.replace("gate_up_proj", key)] = torch.from_numpy(part)
        else:
            state[target] = torch.from_numpy(tensor)
    if used != set(tensors):
        raise ValueError("Some MLC tensors were not consumed")
    if not model_config["tie_word_embeddings"]:
        raise ValueError("This checker expects Qwen2.5 0.5B tied embeddings")
    state["lm_head.weight"] = state["model.embed_tokens.weight"]
    model.load_state_dict(state, strict=True, assign=True)
    model.tie_weights()
    return model.eval(), len(used)


def chat_input(tokenizer, system, prompt):
    text = f"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
    return tokenizer.encode(text, add_special_tokens=False).ids


def main():
    import torch
    import transformers
    from tokenizers import Tokenizer
    from transformers import GenerationConfig

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=ROOT / "public/models/qwen2.5-0.5b")
    parser.add_argument("--cases", type=Path, default=ROOT / "src/diagnostic-cases.json")
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/model-selection/qwen25-05-mlc-cpu-diagnostics.json")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    args.model = args.model.resolve()
    torch.set_num_threads(args.threads)
    source = json.loads((ROOT / "scripts/light-model-source.json").read_text())
    profile = json.loads(args.cases.read_text())
    if profile["settings"]["temperature"] != 0 or profile["settings"]["topP"] != 1:
        raise ValueError("This checker requires the greedy diagnostic profile")
    info = verify_resources(args.model, source)
    if args.verify_only:
        print("All", len(info["files"]), "resources match the pinned source profile")
        return
    config = json.loads((args.model / "resolve/main/mlc-chat-config.json").read_text())
    tensors = load_tensors(args.model, source["cacheManifest"])
    print("Reconstructing pinned MLC Q4 tensors for Transformers CPU FP32 computation", flush=True)
    model, consumed = reconstruct_model(tensors, config)
    del tensors
    tokenizer = Tokenizer.from_file(str(args.model / "resolve/main/tokenizer.json"))
    eos = config["eos_token_id"]
    report = dict(schema=1, kind="mlc-cpu-reference", protocol=profile["protocol"], generatedAt=datetime.now(timezone.utc).isoformat(), model=source["modelId"], revision=source["revision"], engine=f"Transformers {transformers.__version__}", torch=torch.__version__, python=platform.python_version(), numpy=np.__version__, device="CPU", computeDtype="float32", quantization="q4f16_1 reconstructed through FP16; not original unquantized weights", sourceTensorCount=consumed, sourceManifestSha256=hashlib.sha256((args.model / "model-info.json").read_bytes()).hexdigest(), sourceWasmSha256=info["files"][0]["sha256"], systemPrompt=profile["systemPrompt"], settings=profile["settings"], limitations="Independent Transformers execution with the same quantized weights and tokenizer; not the original FP32/BF16 model. Different arithmetic precision can change greedy answers. No browser GPU or device RAM performance measurement.", results=[], complete=False)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for case in profile["cases"]:
        ids = chat_input(tokenizer, profile["systemPrompt"], case["prompt"])
        encoded = torch.tensor([ids], dtype=torch.long)
        generation = GenerationConfig(do_sample=False, top_p=1, temperature=1, repetition_penalty=1, max_new_tokens=case["maxTokens"], eos_token_id=eos, pad_token_id=config["pad_token_id"], bos_token_id=config["bos_token_id"])
        started = time.perf_counter()
        with torch.inference_mode():
            generated = model.generate(encoded, attention_mask=torch.ones_like(encoded), generation_config=generation)
        tokens = generated[0, len(ids):].tolist()
        result = dict(caseId=case["id"], prompt=case["prompt"], maxTokens=case["maxTokens"], text=tokenizer.decode(tokens, skip_special_tokens=True).strip(), finish="complete" if tokens and tokens[-1] in eos else "length", seconds=time.perf_counter() - started, generatedTokens=len(tokens), inputTokens=ids)
        report["results"].append(result)
        partial = args.output.with_suffix(".partial.json")
        partial.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(case["id"], f"{result['seconds']:.2f}s", repr(result["text"]), flush=True)
    report["complete"] = True
    temporary = args.output.with_suffix(".tmp.json")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(args.output)
    print("Saved", args.output, flush=True)


if __name__ == "__main__":
    main()
