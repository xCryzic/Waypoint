# WAYPOINT

A personal goal and roadmap tracker styled like a faded old PC quest log. The application uses Flask for its API and Railway PostgreSQL for production data.

## Run locally

Requires Python 3.11 or newer.

```sh
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
python app.py
```

Open `http://localhost:3000`. When `DATABASE_URL` is absent, local development uses `data/waypoint.db` automatically.

## Deploy to Railway

1. Push this repository to GitHub.
2. In Railway, create a project and choose **Deploy from GitHub repo**.
3. Add a PostgreSQL service to the same Railway project.
4. In the web service's **Variables** tab, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`.
5. Add a stable `SECRET_KEY` containing a long random value.
6. Under **Networking**, generate a public domain.

Railway reads `railway.json`, installs `requirements.txt`, starts Gunicorn, and checks `/health`. Tables are created automatically during startup.

## Tests

```sh
python -m unittest discover -s test -v
```

Passwords use Werkzeug's scrypt hashing. Production sessions are signed, HttpOnly, secure cookies. User data is stored in PostgreSQL rather than the deployment filesystem.
