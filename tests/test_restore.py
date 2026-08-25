import sys, os, json, tempfile, time, unittest
sys.path.insert(0, '.')
from compact.restore import load_latest_checkpoint

class TestLoadLatestCheckpoint(unittest.TestCase):
    def test_load_latest_checkpoint_reads_latest_json(self):
        actual = ".checkpoints"
        actual_path = os.path.join(actual, "tdd_test.json")
        data = {"restored": True, "value": 42}
        with open(actual_path, "w") as f:
            json.dump(data, f)
        try:
            result = load_latest_checkpoint()
            self.assertIsNotNone(result)
            self.assertEqual(result.get("restored"), True)
        finally:
            if os.path.exists(actual_path):
                os.remove(actual_path)

    def test_load_latest_checkpoint_missing_dir(self):
        # Temporarily hide directory
        hidden = ".checkpoints_hidden"
        if os.path.exists(hidden):
            import shutil
            shutil.rmtree(hidden)
        os.rename(".checkpoints", hidden)
        try:
            result = load_latest_checkpoint()
            self.assertIsNone(result)
        finally:
            os.rename(hidden, ".checkpoints")

if __name__ == "__main__":
    unittest.main()
