import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen
from urllib.error import HTTPError

import server


class PublicAssetsTests(unittest.TestCase):
    def test_scripts_load_before_login_but_state_stays_private(self):
        with patch.object(server, "auth_enabled", return_value=True), \
             patch.object(server, "current_session", return_value=None):
            httpd = server.TrainingCoachHTTPServer(("127.0.0.1", 0), server.TrainingCoachHandler)
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            origin = f"http://127.0.0.1:{httpd.server_port}"
            try:
                for name in ("app.js", "coach-overview.js", "workout-comparison.js", "plan-structure.js", "styles.css"):
                    with self.subTest(name=name), urlopen(origin + "/" + name + "?v=test", timeout=5) as response:
                        self.assertEqual(response.read(), (server.ROOT / name).read_bytes())
                with self.assertRaises(HTTPError) as error:
                    urlopen(origin + "/api/state", timeout=5)
                self.assertEqual(error.exception.code, 401)
            finally:
                httpd.shutdown()
                httpd.server_close()
                worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()