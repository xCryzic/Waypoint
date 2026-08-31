import hashlib
import hmac
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, session
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import CheckConstraint, UniqueConstraint, func, select
from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash


ROOT = Path(__file__).resolve().parent
db = SQLAlchemy()


class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(24), nullable=False, unique=True, index=True)
    password_hash = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    goals = db.relationship("Goal", backref="user", cascade="all, delete-orphan", lazy=True)
    __table_args__ = (db.Index("uq_users_username_lower", func.lower(username), unique=True),)


class Goal(db.Model):
    __tablename__ = "goals"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = db.Column(db.String(80), nullable=False)
    description = db.Column(db.String(500), nullable=False, default="")
    category = db.Column(db.String(32), nullable=False, default="")
    icon = db.Column(db.String(4), nullable=False, default="◆")
    status = db.Column(db.String(10), nullable=False, default="ACTIVE")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    completed_at = db.Column(db.DateTime(timezone=True))
    milestones = db.relationship("Milestone", backref="goal", cascade="all, delete-orphan", lazy=True)
    connections = db.relationship("Connection", backref="goal", cascade="all, delete-orphan", lazy=True)
    __table_args__ = (CheckConstraint("status IN ('ACTIVE', 'COMPLETED')", name="valid_goal_status"),)


class Milestone(db.Model):
    __tablename__ = "milestones"
    id = db.Column(db.Integer, primary_key=True)
    goal_id = db.Column(db.Integer, db.ForeignKey("goals.id", ondelete="CASCADE"), nullable=False, index=True)
    title = db.Column(db.String(60), nullable=False)
    description = db.Column(db.String(400), nullable=False, default="")
    notes = db.Column(db.String(2000), nullable=False, default="")
    completed = db.Column(db.Boolean, nullable=False, default=False)
    x = db.Column(db.Float, nullable=False, default=100)
    y = db.Column(db.Float, nullable=False, default=100)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    completed_at = db.Column(db.DateTime(timezone=True))


class Connection(db.Model):
    __tablename__ = "connections"
    id = db.Column(db.Integer, primary_key=True)
    goal_id = db.Column(db.Integer, db.ForeignKey("goals.id", ondelete="CASCADE"), nullable=False, index=True)
    source_milestone_id = db.Column(db.Integer, db.ForeignKey("milestones.id", ondelete="CASCADE"), nullable=False)
    target_milestone_id = db.Column(db.Integer, db.ForeignKey("milestones.id", ondelete="CASCADE"), nullable=False)
    __table_args__ = (
        UniqueConstraint("goal_id", "source_milestone_id", "target_milestone_id", name="unique_connection"),
        CheckConstraint("source_milestone_id != target_milestone_id", name="different_connection_nodes"),
    )


def normalize_database_url(value):
    if not value:
        data_dir = ROOT / "data"
        data_dir.mkdir(exist_ok=True)
        return f"sqlite:///{(data_dir / 'waypoint.db').as_posix()}"
    if value.startswith("postgres://"):
        return value.replace("postgres://", "postgresql+psycopg://", 1)
    if value.startswith("postgresql://"):
        return value.replace("postgresql://", "postgresql+psycopg://", 1)
    return value


def default_secret_key(database_url):
    configured = os.environ.get("SECRET_KEY")
    if configured:
        return configured
    if is_railway() and database_url:
        return hashlib.sha256(f"waypoint-session:{database_url}".encode()).hexdigest()
    return "waypoint-local-development-only"


def is_railway():
    return bool(os.environ.get("RAILWAY_ENVIRONMENT_ID") or os.environ.get("RAILWAY_SERVICE_ID"))


def create_app(test_config=None):
    app = Flask(__name__, static_folder="public", static_url_path="/public")
    raw_database_url = os.environ.get("DATABASE_URL", "")
    if is_railway() and not raw_database_url and not test_config:
        raise RuntimeError("DATABASE_URL is required on Railway. Link the PostgreSQL service variable before deploying.")
    app.config.update(
        SQLALCHEMY_DATABASE_URI=normalize_database_url(raw_database_url),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},
        SECRET_KEY=default_secret_key(raw_database_url),
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=is_railway(),
        MAX_CONTENT_LENGTH=64 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    db.init_app(app)
    register_routes(app)
    register_errors(app)

    with app.app_context():
        db.create_all()

    return app


def now():
    return datetime.now(timezone.utc)


def iso(value):
    if not value:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def clean_text(value, limit, required=False):
    if not isinstance(value, str):
        return None if required else ""
    value = value.strip()[:limit]
    return value if value or not required else None


def json_body():
    return request.get_json(silent=True) or {}


def current_user():
    user_id = session.get("user_id")
    return db.session.get(User, user_id) if user_id else None


def require_user(handler):
    from functools import wraps

    @wraps(handler)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error="Sign in to continue."), 401
        return handler(user, *args, **kwargs)

    return wrapped


def owned_goal(goal_id, user_id):
    return db.session.scalar(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))


def owned_milestone(milestone_id, user_id):
    return db.session.scalar(
        select(Milestone).join(Goal).where(Milestone.id == milestone_id, Goal.user_id == user_id)
    )


def goal_json(goal):
    completed = sum(1 for milestone in goal.milestones if milestone.completed)
    return {
        "id": goal.id,
        "title": goal.title,
        "description": goal.description,
        "category": goal.category,
        "icon": goal.icon,
        "status": goal.status,
        "createdAt": iso(goal.created_at),
        "completedAt": iso(goal.completed_at),
        "completedMilestones": completed,
        "milestoneCount": len(goal.milestones),
    }


def milestone_json(milestone):
    return {
        "id": milestone.id,
        "title": milestone.title,
        "description": milestone.description,
        "notes": milestone.notes,
        "completed": bool(milestone.completed),
        "x": milestone.x,
        "y": milestone.y,
        "createdAt": iso(milestone.created_at),
        "completedAt": iso(milestone.completed_at),
    }


def connection_json(connection):
    return {
        "id": connection.id,
        "sourceId": connection.source_milestone_id,
        "targetId": connection.target_milestone_id,
    }


def legacy_node_password_matches(password, stored):
    """Accept the previous Node scrypt format once, then upgrade it."""
    try:
        salt, expected_hex = stored.split(":", 1)
        actual = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
        return hmac.compare_digest(actual.hex(), expected_hex)
    except (ValueError, TypeError):
        return False


def password_matches(password, stored):
    try:
        if stored.startswith(("scrypt:", "pbkdf2:")):
            return check_password_hash(stored, password)
    except ValueError:
        return False
    return legacy_node_password_matches(password, stored)


def register_routes(app):
    @app.get("/")
    def index():
        return send_from_directory(ROOT, "index.html")

    @app.get("/health")
    def health():
        db.session.execute(select(1))
        return jsonify(status="ok")

    @app.post("/api/auth/register")
    def register():
        data = json_body()
        username = clean_text(data.get("username"), 24, True)
        password = data.get("password") if isinstance(data.get("password"), str) else ""
        if not username or not re.fullmatch(r"[A-Za-z0-9_-]{3,24}", username):
            return jsonify(error="Username must be 3–24 letters, numbers, dashes, or underscores."), 400
        if not 8 <= len(password) <= 128:
            return jsonify(error="Password must be 8–128 characters."), 400
        user = User(username=username, password_hash=generate_password_hash(password, method="scrypt"))
        db.session.add(user)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify(error="That username is already in use."), 409
        session.clear()
        session.permanent = True
        session["user_id"] = user.id
        return jsonify(user={"id": user.id, "username": user.username}), 201

    @app.post("/api/auth/login")
    def login():
        data = json_body()
        username = clean_text(data.get("username"), 24, True)
        password = data.get("password") if isinstance(data.get("password"), str) else ""
        user = db.session.scalar(select(User).where(func.lower(User.username) == (username or "").lower()))
        if not user or not password_matches(password, user.password_hash):
            return jsonify(error="Incorrect username or password."), 401
        if not user.password_hash.startswith(("scrypt:", "pbkdf2:")):
            user.password_hash = generate_password_hash(password, method="scrypt")
            db.session.commit()
        session.clear()
        session.permanent = True
        session["user_id"] = user.id
        return jsonify(user={"id": user.id, "username": user.username})

    @app.get("/api/auth/me")
    @require_user
    def me(user):
        return jsonify(user={"id": user.id, "username": user.username})

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return "", 204

    @app.get("/api/goals")
    @require_user
    def list_goals(user):
        goals = db.session.scalars(
            select(Goal).where(Goal.user_id == user.id).order_by(Goal.status.asc(), Goal.created_at.desc())
        ).unique().all()
        return jsonify(goals=[goal_json(goal) for goal in goals])

    @app.post("/api/goals")
    @require_user
    def create_goal(user):
        data = json_body()
        title = clean_text(data.get("title"), 80, True)
        if not title:
            return jsonify(error="Give this quest a name."), 400
        goal = Goal(
            user_id=user.id,
            title=title,
            description=clean_text(data.get("description"), 500),
            category=clean_text(data.get("category"), 32),
            icon=clean_text(data.get("icon"), 4) or "◆",
        )
        db.session.add(goal)
        db.session.commit()
        return jsonify(goal=goal_json(goal)), 201

    @app.get("/api/goals/<int:goal_id>")
    @require_user
    def get_goal(user, goal_id):
        goal = owned_goal(goal_id, user.id)
        if not goal:
            return jsonify(error="Quest not found."), 404
        return jsonify(
            goal=goal_json(goal),
            milestones=[milestone_json(item) for item in sorted(goal.milestones, key=lambda item: item.id)],
            connections=[connection_json(item) for item in goal.connections],
        )

    @app.patch("/api/goals/<int:goal_id>")
    @require_user
    def update_goal(user, goal_id):
        goal = owned_goal(goal_id, user.id)
        if not goal:
            return jsonify(error="Quest not found."), 404
        data = json_body()
        if "title" in data:
            title = clean_text(data.get("title"), 80, True)
            if not title:
                return jsonify(error="Quest name cannot be empty."), 400
            goal.title = title
        if "description" in data:
            goal.description = clean_text(data.get("description"), 500)
        if "category" in data:
            goal.category = clean_text(data.get("category"), 32)
        if "icon" in data:
            goal.icon = clean_text(data.get("icon"), 4) or "◆"
        if "status" in data:
            if data["status"] not in ("ACTIVE", "COMPLETED"):
                return jsonify(error="Invalid quest status."), 400
            goal.status = data["status"]
            goal.completed_at = (goal.completed_at or now()) if goal.status == "COMPLETED" else None
        db.session.commit()
        return jsonify(goal=goal_json(goal))

    @app.delete("/api/goals/<int:goal_id>")
    @require_user
    def delete_goal(user, goal_id):
        goal = owned_goal(goal_id, user.id)
        if not goal:
            return jsonify(error="Quest not found."), 404
        db.session.delete(goal)
        db.session.commit()
        return "", 204

    @app.post("/api/goals/<int:goal_id>/milestones")
    @require_user
    def create_milestone(user, goal_id):
        goal = owned_goal(goal_id, user.id)
        if not goal:
            return jsonify(error="Quest not found."), 404
        data = json_body()
        title = clean_text(data.get("title"), 60, True)
        if not title:
            return jsonify(error="Give this milestone a title."), 400
        milestone = Milestone(
            goal_id=goal.id,
            title=title,
            description=clean_text(data.get("description"), 400),
            notes=clean_text(data.get("notes"), 2000),
            x=max(24, min(20000, float(data.get("x") or 100))),
            y=max(24, min(20000, float(data.get("y") or 100))),
        )
        db.session.add(milestone)
        db.session.commit()
        return jsonify(milestone=milestone_json(milestone)), 201

    @app.patch("/api/milestones/<int:milestone_id>")
    @require_user
    def update_milestone(user, milestone_id):
        milestone = owned_milestone(milestone_id, user.id)
        if not milestone:
            return jsonify(error="Milestone not found."), 404
        data = json_body()
        if "title" in data:
            title = clean_text(data.get("title"), 60, True)
            if not title:
                return jsonify(error="Milestone title cannot be empty."), 400
            milestone.title = title
        if "description" in data:
            milestone.description = clean_text(data.get("description"), 400)
        if "notes" in data:
            milestone.notes = clean_text(data.get("notes"), 2000)
        if "x" in data:
            milestone.x = max(24, min(20000, float(data.get("x") or 24)))
        if "y" in data:
            milestone.y = max(24, min(20000, float(data.get("y") or 24)))
        if "completed" in data:
            completed = bool(data["completed"])
            milestone.completed = completed
            milestone.completed_at = (milestone.completed_at or now()) if completed else None
        db.session.commit()
        return jsonify(milestone=milestone_json(milestone))

    @app.delete("/api/milestones/<int:milestone_id>")
    @require_user
    def delete_milestone(user, milestone_id):
        milestone = owned_milestone(milestone_id, user.id)
        if not milestone:
            return jsonify(error="Milestone not found."), 404
        Connection.query.filter(
            (Connection.source_milestone_id == milestone.id) | (Connection.target_milestone_id == milestone.id)
        ).delete(synchronize_session=False)
        db.session.delete(milestone)
        db.session.commit()
        return "", 204

    @app.post("/api/goals/<int:goal_id>/connections")
    @require_user
    def create_connection(user, goal_id):
        goal = owned_goal(goal_id, user.id)
        if not goal:
            return jsonify(error="Quest not found."), 404
        data = json_body()
        try:
            source_id, target_id = int(data.get("sourceId")), int(data.get("targetId"))
        except (TypeError, ValueError):
            return jsonify(error="Choose two different milestones from this quest."), 400
        found = db.session.scalar(
            select(func.count(Milestone.id)).where(Milestone.goal_id == goal.id, Milestone.id.in_([source_id, target_id]))
        )
        if source_id == target_id or found != 2:
            return jsonify(error="Choose two different milestones from this quest."), 400
        connection = Connection(goal_id=goal.id, source_milestone_id=source_id, target_milestone_id=target_id)
        db.session.add(connection)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify(error="Those milestones are already connected."), 409
        return jsonify(connection=connection_json(connection)), 201

    @app.delete("/api/connections/<int:connection_id>")
    @require_user
    def delete_connection(user, connection_id):
        connection = db.session.scalar(
            select(Connection).join(Goal).where(Connection.id == connection_id, Goal.user_id == user.id)
        )
        if not connection:
            return jsonify(error="Path not found."), 404
        db.session.delete(connection)
        db.session.commit()
        return "", 204


def register_errors(app):
    @app.errorhandler(404)
    def not_found(error):
        if request.path.startswith("/api/"):
            return jsonify(error="Nothing was found here."), 404
        return error

    @app.errorhandler(413)
    def too_large(error):
        return jsonify(error="That request is too large."), 413

    @app.errorhandler(Exception)
    def unexpected(error):
        app.logger.exception("Unhandled request error")
        db.session.rollback()
        return jsonify(error="The system hit an unexpected snag."), 500


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
