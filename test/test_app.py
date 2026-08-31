import unittest

from app import User, create_app, db


class QuestApiTest(unittest.TestCase):
    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:",
            "SECRET_KEY": "test-secret",
            "SESSION_COOKIE_SECURE": False,
        })
        self.client = self.app.test_client()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()

    def test_complete_quest_journey(self):
        response = self.client.post("/api/auth/register", json={"username": "mapmaker", "password": "a-valid-password"})
        self.assertEqual(response.status_code, 201)
        with self.app.app_context():
            password_hash = db.session.execute(db.select(User.password_hash)).scalar_one()
            self.assertNotIn("a-valid-password", password_hash)

        goal = self.client.post("/api/goals", json={"title": "Learn Blender", "category": "CRAFT", "icon": "▣"}).get_json()["goal"]
        first = self.client.post(f"/api/goals/{goal['id']}/milestones", json={"title": "Basics", "x": 120, "y": 160}).get_json()["milestone"]
        second = self.client.post(f"/api/goals/{goal['id']}/milestones", json={"title": "Scene", "x": 420, "y": 360}).get_json()["milestone"]
        response = self.client.post(f"/api/goals/{goal['id']}/connections", json={"sourceId": first["id"], "targetId": second["id"]})
        self.assertEqual(response.status_code, 201)
        self.client.patch(f"/api/milestones/{first['id']}", json={"completed": True, "notes": "Finished", "x": 5180, "y": 2460})
        self.client.patch(f"/api/goals/{goal['id']}", json={"status": "COMPLETED"})

        saved = self.client.get(f"/api/goals/{goal['id']}").get_json()
        self.assertEqual(saved["goal"]["status"], "COMPLETED")
        self.assertIsNotNone(saved["goal"]["completedAt"])
        self.assertEqual(len(saved["milestones"]), 2)
        self.assertTrue(saved["milestones"][0]["completed"])
        self.assertEqual(saved["milestones"][0]["x"], 5180)
        self.assertEqual(saved["milestones"][0]["y"], 2460)
        self.assertEqual(len(saved["connections"]), 1)

        self.client.post("/api/auth/logout")
        self.assertEqual(self.client.get("/api/goals").status_code, 401)


if __name__ == "__main__":
    unittest.main()
