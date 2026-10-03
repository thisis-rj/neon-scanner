"""Test setup: ingest modules read these at import time; tests never hit the network."""
import os

os.environ.setdefault("EDGAR_USER_AGENT", "neon-scanner-tests test@example.com")
# Overwrite, not setdefault: the nightly job and some shells export the real
# production values, and a test that missed a mock would then write to production.
os.environ["SUPABASE_URL"] = "http://tests.invalid"
os.environ["SUPABASE_SECRET_KEY"] = "tests"
os.environ["SUPABASE_PAT"] = ""
