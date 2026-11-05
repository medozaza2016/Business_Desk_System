-- Bilingual legal names. companies.legal_name already holds the English name and is what
-- {{company_name}} prints; this adds the Arabic twin so a sheet can print both lines of its
-- header lockup from the profile instead of hardcoding them in the template HTML.
ALTER TABLE companies ADD COLUMN legal_name_ar TEXT DEFAULT '';

-- The Challenger sheet used to print both lines as literal text. Backfill them so an existing
-- database keeps printing the same header, but only while the field still holds the seeded
-- display name - a name typed in Settings is never overwritten.
UPDATE companies SET legal_name = 'CHALLENGER USED CARS EXHB. LLC'
 WHERE slug = 'challenger-cars' AND (legal_name IS NULL OR legal_name = '' OR legal_name = name);

UPDATE companies SET legal_name_ar = 'شالنجر للسيارات المستعملة ذ.م.م.'
 WHERE slug = 'challenger-cars' AND (legal_name_ar IS NULL OR legal_name_ar = '');
