import unittest
from unittest.mock import patch

import server


class TelegramMenuTests(unittest.TestCase):
    def test_collects_configured_and_linked_chat_ids(self):
        coaches = [{"id": "coach-a"}, {"id": "coach-b"}]
        athletes = {
            "coach-a": [{"telegram": {"chatId": "200"}}],
            "coach-b": [
                {"telegram": {"chatId": "100"}},
                {"telegram": {"chatId": "300"}},
            ],
        }

        with patch.object(server, "load_coaches", return_value=coaches), patch.object(
            server, "telegram_athletes", side_effect=lambda coach_id: athletes[coach_id]
        ):
            result = server.telegram_menu_chat_ids({"chat_id": "100"})

        self.assertEqual(result, ["100", "200", "300"])

    def test_menu_is_reset_before_commands_are_deleted_and_verified(self):
        events = []

        with patch.object(server, "telegram_command_scopes", return_value=[None]), patch.object(
            server, "telegram_menu_chat_ids", return_value=["100"]
        ), patch.object(
            server,
            "set_telegram_menu_button",
            side_effect=lambda token, chat_id=None: events.append(("menu", chat_id)),
        ), patch.object(
            server,
            "delete_telegram_commands",
            side_effect=lambda token, scope=None, language=None: events.append(("delete", language)),
        ), patch.object(server, "get_telegram_commands", return_value=[]):
            server.configure_telegram_bot_ui({"bot_token": "token", "chat_id": "100"})

        self.assertEqual(events[:2], [("menu", None), ("menu", "100")])
        self.assertEqual([event[0] for event in events[2:]], ["delete", "delete", "delete"])

    def test_cleanup_retries_after_a_transient_error(self):
        delete_results = [OSError("temporary failure"), None, None, None]

        def delete_commands(*args, **kwargs):
            result = delete_results.pop(0)
            if isinstance(result, Exception):
                raise result

        with patch.object(server, "telegram_command_scopes", return_value=[None]), patch.object(
            server, "telegram_menu_chat_ids", return_value=[]
        ), patch.object(server, "set_telegram_menu_button"), patch.object(
            server, "delete_telegram_commands", side_effect=delete_commands
        ) as delete_mock, patch.object(server, "get_telegram_commands", return_value=[]), patch.object(
            server.time, "sleep"
        ) as sleep_mock:
            server.configure_telegram_bot_ui({"bot_token": "token", "chat_id": ""})

        self.assertEqual(delete_mock.call_count, 4)
        sleep_mock.assert_called_once_with(3)


if __name__ == "__main__":
    unittest.main()