"""Developer diagnostic: compare serialized and loaded embeddings without full copies."""
import hashlib
import json
from pathlib import Path


def checkpoint_embeddings(directory):
    found = {}
    for path in sorted(Path(directory).glob("*.safetensors")):
        with path.open("rb") as stream:
            header_bytes = int.from_bytes(stream.read(8), "little")
            if not 0 < header_bytes <= 100_000_000:
                raise ValueError("Invalid safetensors header length")
            header = json.loads(stream.read(header_bytes))
            for key in ["model.embed_tokens.weight", "lm_head.weight"]:
                if key not in header:
                    continue
                tensor = header[key]
                start, end = tensor["data_offsets"]
                if start < 0 or end < start or 8 + header_bytes + end > path.stat().st_size:
                    raise ValueError("Invalid safetensors embedding range")
                stream.seek(8 + header_bytes + start)
                digest = hashlib.sha256()
                remaining = end - start
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Truncated safetensors embedding")
                    digest.update(chunk)
                    remaining -= len(chunk)
                found[key] = dict(dtype=tensor["dtype"], shape=tensor["shape"], bytes=end - start, sha256=digest.hexdigest())
    return found


def audit_embeddings(directory, model):
    import torch
    checkpoint = checkpoint_embeddings(directory)
    input_weight = model.get_input_embeddings().weight
    output_weight = model.get_output_embeddings().weight
    result = dict(configTied=bool(model.config.tie_word_embeddings), loadedTied=input_weight.data_ptr() == output_weight.data_ptr(), source=checkpoint)
    for key, weight in [("model.embed_tokens.weight", input_weight), ("lm_head.weight", output_weight)]:
        source = checkpoint.get(key)
        if source is None:
            continue
        dtype = {"BF16": torch.bfloat16, "F16": torch.float16, "F32": torch.float32}[source["dtype"]]
        digest = hashlib.sha256()
        for start in range(0, weight.shape[0], 128):
            data = weight[start:start + 128].detach().to(dtype=dtype).contiguous().view(torch.uint8).numpy().tobytes()
            digest.update(data)
        source["loadedSha256AtSourcePrecision"] = digest.hexdigest()
        source["matchesLoaded"] = source["sha256"] == digest.hexdigest()
    if len(checkpoint) == 2:
        result["sourceEmbeddingAndHeadEqual"] = checkpoint["model.embed_tokens.weight"]["sha256"] == checkpoint["lm_head.weight"]["sha256"]
    return result
