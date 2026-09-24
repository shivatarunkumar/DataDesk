# Data contracts

Optional extra rules for a target table, checked on top of its live schema when someone
asks to load a file into it (`services/validators.py`). No file means schema checks only.

One JSON file per table: `data-contracts/{postgres|bigquery}/{table}.json`

```json
{
  "columns": [
    { "name": "customer_id", "required": true, "regex": "^C[0-9]{6}$" },
    { "name": "segment", "enum": ["retail", "business", "private"] },
    { "name": "credit_limit", "min": 0, "max": 250000 }
  ]
}
```

| Key | Meaning |
|---|---|
| `required` | the value may not be empty |
| `regex` | the whole value must match |
| `enum` | the value must be one of these |
| `min` / `max` | numeric bounds |
