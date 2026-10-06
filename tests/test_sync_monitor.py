import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import contextmanager, closing, ExitStack
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen
from urllib.error import HTTPError

import server
import sync_monitor


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'test.sqlite3'
        self.scope = ('coach-a', 'athlete-a', 'polar')
        self.monitor = sync_monitor.Monitor(self.connect)

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            yield db

    def test_empty_read_does_not_create_schema(self):
        self.assertEqual(self.monitor.history(self.scope), [])
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT name FROM sqlite_master').fetchall(), [])

    def test_success_counts_and_no_new_records(self):
        self.monitor.execute(self.scope, lambda: {'ok': True, 'count': 3, 'added': 1, 'duplicates': 2, 'savedTcx': ['a','b','c']}, expect_tcx=True)
        event = self.monitor.history(self.scope)[0]
        self.assertEqual((event['state'],event['received'],event['added'],event['duplicates'],event['tcx']), ('success',3,1,2,3))
        self.monitor.execute(self.scope, lambda: {'ok': True, 'count': 0}, automatic=True, expect_tcx=True)
        event = self.monitor.history(self.scope)[0]
        self.assertEqual((event['state'],event['received'],event['trigger']), ('success',0,'background'))
        self.assertIsNotNone(event['finishedAt'])

    def test_partial_tcx_is_distinct_from_success_and_error(self):
        self.monitor.execute(self.scope, lambda: {'count': 2, 'added': 2, 'savedTcx': ['a']}, expect_tcx=True)
        event = self.monitor.history(self.scope)[0]
        self.assertEqual((event['state'],event['code']), ('partial','tcx'))
        self.monitor.execute(self.scope, lambda: {'ok': False})
        self.assertEqual(self.monitor.history(self.scope)[0]['state'], 'error')

    def test_error_is_sanitized_and_persisted(self):
        for exc, code in [(TimeoutError('SECRET'), 'timeout'), (server.AppError('SECRET',403),'access'), (server.AppError('SECRET',429),'rate_limit'), (OSError('SECRET'),'network'), (ValueError('SECRET'),'internal')]:
            with self.subTest(code=code), self.assertRaises(type(exc)):
                self.monitor.execute(self.scope, lambda: (_ for _ in ()).throw(exc))
            event = self.monitor.history(self.scope)[0]
            self.assertEqual((event['state'],event['code']), ('error',code))
            self.assertNotIn('SECRET', json.dumps(event))
        restarted = sync_monitor.Monitor(self.connect)
        self.assertEqual(len(restarted.history(self.scope)), 5)
        with self.connect() as db:
            self.assertNotIn('SECRET', str(db.execute('SELECT * FROM sync_journal').fetchall()))

    def test_retention_and_scope_isolation(self):
        for i in range(24):
            self.monitor.execute(self.scope, lambda: {'count': i})
        for scope in [('coach-b','athlete-a','polar'),('coach-a','athlete-b','polar'),('coach-a','athlete-a','runalyze')]:
            self.assertEqual(self.monitor.history(scope), [])
            self.monitor.execute(scope, lambda: {'count': 99})
            self.assertEqual(len(self.monitor.history(scope)), 1)
        events = self.monitor.history(self.scope)
        self.assertEqual(len(events),20)
        self.assertEqual(events[0]['received'],23)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sync_journal').fetchone()[0],23)

    def test_restart_marks_old_running_attempt_as_interrupted(self):
        self.monitor.record({'id':'old','trigger':'manual','started':10,'state':'running'}, self.scope)
        restarted = sync_monitor.Monitor(self.connect)
        self.assertEqual(restarted.history(self.scope)[0]['state'],'interrupted')
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT state FROM sync_journal').fetchone()[0],'running')

    def test_concurrent_request_does_not_replace_active_attempt(self):
        entered, release = threading.Event(), threading.Event()
        def callback():
            entered.set()
            release.wait(3)
            return {'count':1}
        worker = threading.Thread(target=lambda: self.monitor.execute(self.scope,callback))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            first = self.monitor.history(self.scope)[0]
            self.assertEqual(first['state'],'running')
            result = self.monitor.execute(self.scope,lambda: self.fail('Must not run twice'))
            self.assertTrue(result['skipped'])
            self.assertEqual(self.monitor.history(self.scope)[0]['id'], first['id'])
        finally:
            release.set()
            worker.join(3)
        self.assertEqual(len(self.monitor.history(self.scope)),1)
        self.assertEqual(self.monitor.history(self.scope)[0]['state'],'success')

    def test_provider_lock_skip_is_journaled(self):
        self.monitor.execute(self.scope, lambda: {'skipped':True})
        self.assertEqual(self.monitor.history(self.scope)[0]['state'],'skipped')

    def test_journal_failure_does_not_abort_sync(self):
        def failed(): raise sqlite3.OperationalError('SECRET')
        monitor = sync_monitor.Monitor(failed)
        with self.assertLogs(level='WARNING') as logs:
            self.assertEqual(monitor.execute(self.scope,lambda: {'added':1}), {'added':1})
        self.assertFalse(monitor.journal_available)
        self.assertNotIn('SECRET',str(logs.output))


class DiagnosticsTests(unittest.TestCase):
    # Separate database and synthetic athletes; never touch project state.
    def setUp(self):
        JournalTests.setUp(self)
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(server,'DB_PATH',self.path))
        stack.enter_context(patch.object(server,'DB_INITIALIZED',False))
        stack.enter_context(patch.object(server,'SYNC_MONITOR',self.monitor))
        stack.enter_context(patch.object(server,'POLAR_CONFIG',{'enabled':True,'downloadTcx':True}))
        stack.enter_context(patch.object(server,'INTEGRATIONS_CONFIG',{'runalyze':{'enabled':True},'strava':{'enabled':False,'visible':False}}))
        self.http = stack.enter_context(patch.object(server,'http_bytes',side_effect=AssertionError('No network expected')))
        server.init_db()
        server.save_state_value('athletes',[{'id':'athlete-a','name':'Athlete A','integrations':{'polar':{'token':{'access_token':'SECRET'},'lastSync':123},'runalyze':{'token':'SECRET','readAccess':'denied','lastError':'SECRET'}}}],coach_id='coach-a')
        server.save_state_value('athletes',[{'id':'athlete-b','name':'Athlete B'}],coach_id='coach-b')
        self.coach = {'role':'coach','coach_id':'coach-a'}
        self.student = {'role':'student','coach_id':'coach-a','athlete_id':'athlete-a'}

    connect = JournalTests.connect
    def test_empty_read_does_not_create_schema(self):
        with self.connect() as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='sync_journal'").fetchone())
        server.diagnostics_for_session(self.student)
        with self.connect() as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='sync_journal'").fetchone())

    def test_roles_and_coach_scoping(self):
        for session, target, status in [(None,'',401),(self.student,'athlete-b',403),(self.coach,'athlete-b',404),({'role':'student','coach_id':'coach-b','athlete_id':'athlete-a'},'',404)]:
            with self.subTest(session=session), self.assertRaises(server.AppError) as caught:
                server.diagnostics_for_session(session,target)
            self.assertEqual(caught.exception.status,status)
        self.assertEqual(server.diagnostics_for_session(self.coach)['providers'],[])

    def test_read_only_scoped_sanitized_response(self):
        self.monitor.execute(self.scope,lambda: {'count':1,'added':1})
        self.monitor.execute(('coach-b','athlete-b','polar'),lambda: {'count':99})
        with self.connect() as db:
            before = list(db.iterdump())
        data = server.diagnostics_for_session(self.student)
        self.assertEqual(data['athleteId'],'athlete-a')
        self.assertEqual(data['providers'][0]['events'][0]['received'],1)
        self.assertNotIn('SECRET',json.dumps(data))
        self.assertNotIn('Athlete B',json.dumps(data))
        self.assertEqual([p['provider'] for p in data['providers']],['polar','runalyze'])
        self.http.assert_not_called()
        with self.connect() as db:
            self.assertEqual(before,list(db.iterdump()))

    def test_observed_sync_uses_correct_scope_and_safe_error(self):
        with patch.object(server,'sync_polar_workouts',side_effect=TimeoutError('SECRET')) as sync:
            with self.assertRaises(server.AppError) as caught:
                server.observed_sync('polar',coach_id='coach-a',athlete_id='athlete-a')
            self.assertNotIn('SECRET',str(caught.exception))
            sync.assert_called_once_with(store=True,automatic=False,coach_id='coach-a',athlete_id='athlete-a')
        self.assertEqual(self.monitor.history(self.scope)[0]['code'],'timeout')

    def test_one_provider_failure_does_not_stop_others(self):
        with patch.object(server,'connected_integration_targets',return_value=[('coach-a','athlete-a')]), patch.object(server,'athlete_integration',return_value={'readAccess':'granted'}), patch.object(server,'observed_sync',side_effect=[server.AppError('Unavailable',504),{'ok':True,'count':2,'added':1}]) as sync:
            result = server.sync_connected_integrations(automatic=True)
        self.assertEqual([c.args[0] for c in sync.call_args_list],['polar','runalyze'])
        self.assertFalse(result['ok'])
        self.assertEqual(result['added'],1)

    def test_background_disabled_provider_is_not_contacted(self):
        with patch.object(server,'integration_config',return_value={'enabled':True,'backgroundSync':False}), patch.object(server,'connected_integration_targets') as targets:
            server.sync_connected_integrations(automatic=True)
        targets.assert_not_called()

    def test_http_requires_login_and_health_is_minimal(self):
        with patch.object(server,'auth_enabled',return_value=True), patch.object(server,'current_session',return_value=None):
            httpd = server.TrainingCoachHTTPServer(('127.0.0.1',0),server.TrainingCoachHandler)
            worker = threading.Thread(target=httpd.serve_forever,daemon=True)
            worker.start()
            try:
                origin = f'http://127.0.0.1:{httpd.server_port}'
                with urlopen(origin+'/api/health',timeout=3) as response:
                    self.assertEqual(json.load(response),{'ok':True})
                try:
                    urlopen(origin+'/api/diagnostics?athleteId=athlete-a',timeout=3)
                    self.fail('Expected 401')
                except HTTPError as exc:
                    self.assertEqual(exc.code,401)
                    exc.close()
                with patch.object(server,'current_session',return_value=self.student):
                    with urlopen(origin+'/api/diagnostics',timeout=3) as response:
                        self.assertEqual(json.load(response)['athleteId'],'athlete-a')
            finally:
                httpd.shutdown()
                httpd.server_close()
                worker.join(3)


if __name__ == '__main__':
    unittest.main()