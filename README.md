# Spark Tracker

Income and mileage tracker for Walmart Spark drivers. Phone-first web app (installable
as a PWA), Flask + SQLite, no build step.

## Features
- **Home:** this week's totals, a "Log a shift" form built for entering shifts after the fact
  (date, start/end time, odometer or miles, and each offer with live $/mile and after-gas
  numbers), and your recent shifts. Overnight shifts are handled automatically, the last
  ending odometer is one tap away, and an unfinished entry is kept as a draft.
- **Log:** shifts grouped by day, edit any shift and its offers, log past shifts, add
  bonuses (weekly challenges, referrals) not tied to an offer. Flags shifts missing miles
  and offers with no tip yet.
- **Gas:** enter $/gallon and your car's average MPG at each fill-up. Each shift's gas cost is
  estimated as Spark miles ÷ MPG × price (using the fill-up in effect that day), so personal
  driving never skews it. Offers show "≈ $X after gas" as you enter them.
- **Expenses:** maintenance, parking/tolls, phone, supplies. Vehicle costs are tracked for your
  real cost per mile but not double-deducted (the IRS standard mileage rate covers them).
- **Stats:** week/month/year earnings chart (pay vs tips), $/hr, $/mile, avg offer, best days,
  offer-type and store comparisons, and a tax estimate (mileage deduction, SE tax, income tax set-aside).
- **Settings:** weekly goal, tax set-aside %, week start day, IRS mileage rates per year,
  CSV exports (IRS-style mileage log, income, expenses) and a full database backup.

Tax numbers are estimates, not tax advice.

## Run
```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
FLASK_DEBUG=true venv/bin/python3 app.py
```
Open http://localhost:5052 (or http://<your-mac>.local:5052 from your phone on the same Wi-Fi),
then "Add to Home Screen" to install it. `FLASK_HOST` and `PORT` env vars override the defaults.

## Raspberry Pi
Runs as the systemd service in `deploy/spark-tracker.service` on port 5052, alongside
Card Tracker (5001) and Dinner Deck (5050). To update: `git pull`, then
`sudo systemctl restart spark-tracker.service`.
