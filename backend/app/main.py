from fastapi import FastAPI

from app.journal.router import router as journal_router

app = FastAPI(title="SeekJournal API")

app.include_router(journal_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
