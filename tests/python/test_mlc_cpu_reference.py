"""Small fixtures for the development-only MLC Q4 CPU control."""
import importlib.util
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("mlc_cpu_reference", ROOT / "scripts/run-mlc-cpu-reference.py")
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


class DequantizationTests(unittest.TestCase):
    def test_known_little_endian_nibbles_and_distinct_rows(self):
        packed = np.array([[0x76543210, 0xFEDCBA98, 0x76543210, 0xFEDCBA98]] * 2, dtype=np.uint32)
        actual = reference.dequantize_q4f16_1(packed, np.array([[0.5], [2]], dtype=np.float16))
        values = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8] * 2
        np.testing.assert_array_equal(actual, np.array([[value / 2 for value in values], [value * 2 for value in values]], dtype=np.float32))

    def test_scale_changes_at_the_32_element_boundary(self):
        packed = np.full((1, 8), 0x88888888, dtype=np.uint32)
        scales = np.array([[0.1, 0.5]], dtype=np.float16)
        actual = reference.dequantize_q4f16_1(packed, scales)
        np.testing.assert_array_equal(actual[0, :32], np.full(32, float(np.float16(0.1)), dtype=np.float32))
        np.testing.assert_array_equal(actual[0, 32:], np.full(32, 0.5, dtype=np.float32))

    def test_rejects_wrong_layout_or_dtype(self):
        with self.assertRaises(ValueError):
            reference.dequantize_q4f16_1(np.ones((1, 5), dtype=np.uint32), np.ones((1, 1), dtype=np.float16))
        with self.assertRaises(ValueError):
            reference.dequantize_q4f16_1(np.ones((1, 4), dtype=np.uint32), np.ones((1, 1), dtype=np.float32))

    def test_exact_qwen2_chat_template_without_thinking_prefix(self):
        class Recorder:
            def encode(self, text, add_special_tokens):
                self.text = text
                self.add_special_tokens = add_special_tokens
                return type("Encoded", (), {"ids": [1, 2, 3]})()

        tokenizer = Recorder()
        self.assertEqual(reference.chat_input(tokenizer, "You are a helpful assistant.", "Сколько будет 2 + 2?"), [1, 2, 3])
        self.assertFalse(tokenizer.add_special_tokens)
        self.assertEqual(tokenizer.text, "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n<|im_start|>user\nСколько будет 2 + 2?<|im_end|>\n<|im_start|>assistant\n")


if __name__ == "__main__":
    unittest.main()
