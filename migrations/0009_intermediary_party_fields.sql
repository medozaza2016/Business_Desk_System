-- The intermediary is a party like the seller and the buyer -----------------------------
-- It carries the same four fields (name, ID, phone, address) and no commission: the
-- sheet prints the broker's details, not a fee the desk does not settle.
ALTER TABLE agreements ADD COLUMN intermediary_id_number TEXT NOT NULL DEFAULT '';
ALTER TABLE agreements ADD COLUMN intermediary_address TEXT NOT NULL DEFAULT '';

-- The commission was free text nothing computed or totalled; the row is dropped outright.
ALTER TABLE agreements DROP COLUMN intermediary_commission;
