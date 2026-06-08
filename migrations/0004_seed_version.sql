-- Seed re-push: remember the SEED_VERSION (content stamp of the skill tree) last written into
-- each user's sandbox. Sandboxes are reused across turns, so a deploy that changes the skill
-- files would otherwise leave existing VMs on the old skill forever. When the incoming
-- SEED_VERSION differs we re-push SEED_FILES in place (same VM, no reprovision). NULL on legacy
-- rows → treated as stale → re-seeded on next turn.

ALTER TABLE agent_computers ADD COLUMN seed_version TEXT;
