import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reference_orthrus_ar', ROOT / 'scripts/reference_orthrus_ar.py')
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


class ExactArSubnetworkTests(unittest.TestCase):
    def setUp(self):
        self.config = dict(architectures=['OrthrusLM'], model_type='qwen3', num_hidden_layers=28)
        self.auxiliary = [f'model.layers.{layer}.self_attn.{name}_diff.weight' for layer in range(28) for name in ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'q_norm', 'k_norm']]

    def test_accepts_only_the_audited_auxiliary_branch(self):
        variant = reference.validate_native_ar_load(self.config, dict(unexpected_keys=self.auxiliary))
        self.assertEqual(variant['excludedAuxiliaryTensorCount'], 168)
        self.assertEqual(set(variant['excludedAuxiliaryTensors']), set(self.auxiliary))

    def test_rejects_uninitialized_or_mismatched_native_weights(self):
        for key in ['missing_keys', 'mismatched_keys', 'error_msgs']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                reference.validate_native_ar_load(self.config, dict(unexpected_keys=self.auxiliary, **{key: ['model.norm.weight']}))

    def test_rejects_skipping_any_other_tensor(self):
        with self.assertRaises(ValueError):
            reference.validate_native_ar_load(self.config, dict(unexpected_keys=self.auxiliary + ['lm_head.weight']))
        with self.assertRaises(ValueError):
            reference.validate_native_ar_load(self.config, dict(unexpected_keys=self.auxiliary[:-1]))

    def test_rejects_a_different_model_architecture(self):
        config = dict(self.config, num_hidden_layers=32)
        with self.assertRaises(ValueError):
            reference.validate_native_ar_load(config, dict(unexpected_keys=self.auxiliary))


if __name__ == '__main__':
    unittest.main()
