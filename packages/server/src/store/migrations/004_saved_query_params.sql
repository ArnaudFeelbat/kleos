-- 0.7: the parameter values last used with a saved query, offered again on its next run.
-- JSON object by placeholder ({"$1": "42", ":customer": null}) or NULL when none were kept.
ALTER TABLE saved_queries ADD COLUMN param_values TEXT;
