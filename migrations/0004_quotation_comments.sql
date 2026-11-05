-- Free-form comments printed on the sheet. The Challenger template has a fourth vehicle row
-- ("Comments:" / "ملاحظات:") that asks for {{comments}}; without this column the row printed
-- blank, so the note now lives on the quotation itself and is editable from the record page.
ALTER TABLE quotations ADD COLUMN comments TEXT DEFAULT '';
