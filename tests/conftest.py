"""Test setup: ingest modules read these at import time; tests never hit the network."""
import os

os.environ.setdefault("EDGAR_USER_AGENT", "neon-scanner-tests test@example.com")
os.environ.setdefault("SUPABASE_URL", "http://tests.invalid")
os.environ.setdefault("SUPABASE_SECRET_KEY", "tests")
