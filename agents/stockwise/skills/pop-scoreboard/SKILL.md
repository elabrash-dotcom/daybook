---
name: pop-scoreboard
description: Make a phone-size pop-poster PNG scoreboard (Poppins ExtraBold, black outlines, hard shadows, Mobiletek yellow, MCC blue) for StockWise briefs and reports in Daybook.
---

# Pop scoreboard

Use this skill when a StockWise card needs a poster image.

1. Write a JSON spec (only figures that came from StockWise tools):

```json
{
  "title": "Morning brief",
  "subtitle": "Tue 10 Nov · month to date",
  "shops": [
    {"name": "Mobiletek", "theme": "mobiletek", "big": "$27,210", "label": "MTD vs $25,000 TTD",
     "status": "ahead", "chip": "+$2,210", "rows": [["Yesterday", "$2,840"], ["Need / day", "$2,130"]]},
    {"name": "MCC Eastern Creek", "theme": "mcc", "big": "$13,460", "label": "MTD vs $15,600 TTD",
     "status": "behind", "chip": "-$2,140", "rows": [["Yesterday", "$1,020"], ["Need / day", "$1,762"]]}
  ],
  "footer": "Fairfield excluded · figures from StockWise"
}
```

- `theme` is `mobiletek` (yellow #ffd93d), `mcc` (blue #4ad6ff) or `combined` (white).
- `status` is `ahead` (green chip), `behind` (red chip) or `even` (white chip).
- `rows` is optional: at most 4 rows per shop. Keep labels short.
- Use 1 to 3 shops.
- The script downloads the Poppins font the first time it runs (from the npm registry).

2. Render it:

```bash
pip install pillow >/dev/null 2>&1 || true
python3 SKILL_DIR/render.py spec.json /mnt/session/outputs/poster.png
```

Replace `SKILL_DIR` with this skill's folder. The output is a 1080×1920 PNG, phone size.

3. Look at the PNG with the `read` tool before posting it. If any text is cut off or overlapping, shorten it and render again.
