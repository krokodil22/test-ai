import hashlib
import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("reference_embedding_audit", ROOT / "scripts/reference_embedding_audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class EmbeddingCheckpointTests(unittest.TestCase):
    def fixture(self, directory, equal=False):
        first = struct.pack('<4f', 1, 2, 3, 4)
        second = first if equal else struct.pack('<4f', 5, 6, 7, 8)
        header = json.dumps({
            'model.embed_tokens.weight': {'dtype': 'F32', 'shape': [2, 2], 'data_offsets': [0, 16]},
            'lm_head.weight': {'dtype': 'F32', 'shape': [2, 2], 'data_offsets': [16, 32]},
        }).encode()
        header += b' ' * (-len(header) % 8)
        path = Path(directory) / 'model.safetensors'
        path.write_bytes(len(header).to_bytes(8, 'little') + header + first + second)
        return path, first, second

    def test_hashes_exact_payload_ranges_instead_of_the_file_header(self):
        with tempfile.TemporaryDirectory() as directory:
            _, first, second = self.fixture(directory)
            found = audit.checkpoint_embeddings(directory)
            self.assertEqual(found['model.embed_tokens.weight']['sha256'], hashlib.sha256(first).hexdigest())
            self.assertEqual(found['lm_head.weight']['sha256'], hashlib.sha256(second).hexdigest())
            self.assertNotEqual(found['model.embed_tokens.weight']['sha256'], found['lm_head.weight']['sha256'])

    def test_identical_serialized_embeddings_have_identical_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fixture(directory, equal=True)
            found = audit.checkpoint_embeddings(directory)
            self.assertEqual(found['model.embed_tokens.weight']['sha256'], found['lm_head.weight']['sha256'])

    def test_truncated_embedding_payload_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _, _ = self.fixture(directory)
            path.write_bytes(path.read_bytes()[:-1])
            with self.assertRaises(ValueError):
                audit.checkpoint_embeddings(directory)


if __name__ == '__main__':
    unittest.main()
