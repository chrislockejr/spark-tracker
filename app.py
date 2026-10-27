import csv
import io
import os
from collections import defaultdict
from datetime import date, datetime, timedelta

from flask import Flask, Response, jsonify, render_template, request, send_file, send_from_directory

from models import (
    DEFAULT_SETTINGS,
    EXPENSE_CATEGORIES,
    OFFER_TYPES,
    VEHICLE_CATEGORIES,
    Bonus,
    Expense,
    FuelFill,
    FuelLookup,
    Shift,
    Trip,
    db,
    get_settings,
    rate_for_year,
    save_settings,
)

SE_TAX_RATE = 0.153  # Social Security + Medicare for the self-employed
SE_TAX_BASE = 0.9235  # SE tax applies to 92.35% of net profit


def create_app():
    app = Flask(__name__)
    os.makedirs(app.instance_path, exist_ok=True)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///spark_tracker.db"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    db.init_app(app)

    with app.app_context():
        db.create_all()

    register_routes(app)
    return app


# ---------------------------------------------------------------- helpers ---

def parse_dt(value):
    if not value:
        return None
    return datetime.fromisoformat(value)


def parse_date(value):
    if not value:
        return None
    return date.fromisoformat(value[:10])


def num(value, default=None):
    if value in (None, ""):
        return default
    return float(value)


def bad_request(message):
    return jsonify({"error": message}), 400


def date_range_args():
    """Return (start_date, end_date) inclusive from ?start=&end= query args."""
    start = parse_date(request.args.get("start")) or date(2000, 1, 1)
    end = parse_date(request.args.get("end")) or date(2100, 1, 1)
    return start, end


def shifts_between(start, end):
    return (
        Shift.query.filter(
            Shift.start_time >= datetime.combine(start, datetime.min.time()),
            Shift.start_time < datetime.combine(end + timedelta(days=1), datetime.min.time()),
        )
        .order_by(Shift.start_time.desc())
        .all()
    )


def apply_trip_fields(trip, data):
    trip.offer_type = data.get("offer_type") or "Other"
    trip.store = (data.get("store") or "").strip()
    trip.base_pay = num(data.get("base_pay"), 0)
    trip.tip = num(data.get("tip"), 0)
    trip.incentive = num(data.get("incentive"), 0)
    trip.miles = num(data.get("miles"))
    trip.deliveries = int(data.get("deliveries") or 1)
    trip.notes = data.get("notes") or ""


def apply_shift_fields(shift, data):
    shift.start_time = parse_dt(data.get("start_time")) or shift.start_time
    if "end_time" in data:
        shift.end_time = parse_dt(data.get("end_time"))
    for field in ("start_odometer", "end_odometer", "miles"):
        if field in data:
            setattr(shift, field, num(data.get(field)))
    if "notes" in data:
        shift.notes = data.get("notes") or ""
    if shift.end_time and shift.end_time < shift.start_time:
        raise ValueError("Shift end time is before its start time.")
    if (
        shift.start_odometer is not None
        and shift.end_odometer is not None
        and shift.end_odometer < shift.start_odometer
    ):
        raise ValueError("Ending odometer is lower than starting odometer.")


def sync_trips(shift, trips_data):
    """Replace a shift's trips with the given list (update by id, add new, drop missing)."""
    existing = {t.id: t for t in shift.trips}
    keep = set()
    for data in trips_data:
        trip = existing.get(data.get("id"))
        if trip is None:
            trip = Trip(shift=shift)
            db.session.add(trip)
        apply_trip_fields(trip, data)
        if trip.id:
            keep.add(trip.id)
    for trip_id, trip in existing.items():
        if trip_id not in keep:
            shift.trips.remove(trip)


def bucket_key(d, granularity, week_start):
    if granularity == "month":
        return d.strftime("%Y-%m")
    if granularity == "week":
        offset = (d.weekday() - week_start) % 7
        return (d - timedelta(days=offset)).isoformat()
    return d.isoformat()


def bucket_keys(start, end, granularity, week_start):
    keys = []
    d = start
    while d <= end:
        key = bucket_key(d, granularity, week_start)
        if not keys or keys[-1] != key:
            keys.append(key)
        d += timedelta(days=1)
    return keys


def compute_stats(start, end, granularity="day"):
    settings = get_settings()
    week_start = int(settings.get("week_start", 0))
    shifts = shifts_between(start, end)
    expenses = Expense.query.filter(Expense.date >= start, Expense.date <= end).all()
    bonuses = Bonus.query.filter(Bonus.date >= start, Bonus.date <= end).all()
    fuel = FuelLookup()

    t = defaultdict(float)
    by_type = defaultdict(lambda: defaultdict(float))
    by_store = defaultdict(lambda: defaultdict(float))
    by_weekday = defaultdict(lambda: defaultdict(float))
    series = {
        k: defaultdict(float) for k in bucket_keys(start, end, granularity, week_start)
    }

    for shift in shifts:
        day = shift.start_time.date()
        key = bucket_key(day, granularity, week_start)
        miles = shift.total_miles or 0
        deduction = miles * rate_for_year(settings, day.year)
        fuel_cost = fuel.cost(day, miles) or 0
        t["fuel_cost"] += fuel_cost
        series[key]["fuel"] += fuel_cost
        t["shifts"] += 1
        t["hours"] += shift.hours
        t["miles"] += miles
        t["mileage_deduction"] += deduction
        series[key]["miles"] += miles
        series[key]["hours"] += shift.hours
        wd = by_weekday[day.weekday()]
        wd["hours"] += shift.hours
        wd["shifts"] += 1
        wd["fuel"] += fuel_cost
        for trip in shift.trips:
            t["base_pay"] += trip.base_pay or 0
            t["tips"] += trip.tip or 0
            t["incentives"] += trip.incentive or 0
            t["trips"] += 1
            t["deliveries"] += trip.deliveries or 1
            series[key]["gross"] += trip.total
            series[key]["tips"] += trip.tip or 0
            wd["gross"] += trip.total
            bt = by_type[trip.offer_type or "Other"]
            bt["count"] += 1
            bt["gross"] += trip.total
            bt["tips"] += trip.tip or 0
            if trip.miles:
                bt["miles"] += trip.miles
                bt["gross_with_miles"] += trip.total
            if trip.store:
                bs = by_store[trip.store]
                bs["count"] += 1
                bs["gross"] += trip.total
                bs["tips"] += trip.tip or 0

    for bonus in bonuses:
        t["bonuses"] += bonus.amount
        series[bucket_key(bonus.date, granularity, week_start)]["gross"] += bonus.amount

    for expense in expenses:
        t["total_expenses"] += expense.amount
        if expense.category in VEHICLE_CATEGORIES:
            t["vehicle_expenses"] += expense.amount
        else:
            t["deductible_expenses"] += expense.amount
        series[bucket_key(expense.date, granularity, week_start)]["expenses"] += expense.amount

    gross = t["base_pay"] + t["tips"] + t["incentives"] + t["bonuses"]
    profit = max(gross - t["mileage_deduction"] - t["deductible_expenses"], 0)
    se_tax = profit * SE_TAX_BASE * SE_TAX_RATE
    income_tax = profit * float(settings.get("income_tax_pct", 0)) / 100

    def ratio(a, b):
        return round(a / b, 2) if b else None

    # Real out-of-pocket costs: estimated gas plus everything logged as an expense.
    costs = t["fuel_cost"] + t["total_expenses"]

    totals = {k: round(v, 2) for k, v in t.items()}
    totals.update(
        {
            "gross": round(gross, 2),
            "has_fuel": bool(fuel.fills),
            "fuel_cost": round(t["fuel_cost"], 2),
            "costs": round(costs, 2),
            "net_cash": round(gross - costs, 2),
            "taxable_profit": round(profit, 2),
            "se_tax": round(se_tax, 2),
            "income_tax": round(income_tax, 2),
            "set_aside": round(se_tax + income_tax, 2),
            "per_hour": ratio(gross, t["hours"]),
            "net_per_hour": ratio(gross - costs, t["hours"]),
            "vehicle_cost_per_mile": ratio(t["fuel_cost"] + t["vehicle_expenses"], t["miles"]),
            "per_mile": ratio(gross, t["miles"]),
            "per_trip": ratio(gross - t["bonuses"], t["trips"]),
            "tip_share": ratio(t["tips"] * 100, gross - t["bonuses"]),
        }
    )
    for k in ("shifts", "trips", "deliveries"):
        totals[k] = int(t[k])

    weekday_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "granularity": granularity,
        "totals": totals,
        "series": [
            {"key": k, **{m: round(v.get(m, 0), 2) for m in ("gross", "tips", "miles", "hours", "expenses", "fuel")}}
            for k, v in series.items()
        ],
        "by_type": sorted(
            (
                {
                    "offer_type": name,
                    "count": int(v["count"]),
                    "gross": round(v["gross"], 2),
                    "avg": ratio(v["gross"], v["count"]),
                    "avg_tip": ratio(v["tips"], v["count"]),
                    "per_mile": ratio(v["gross_with_miles"], v["miles"]),
                }
                for name, v in by_type.items()
            ),
            key=lambda r: -r["gross"],
        ),
        "by_store": sorted(
            (
                {
                    "store": name,
                    "count": int(v["count"]),
                    "gross": round(v["gross"], 2),
                    "avg": ratio(v["gross"], v["count"]),
                    "avg_tip": ratio(v["tips"], v["count"]),
                }
                for name, v in by_store.items()
            ),
            key=lambda r: -r["gross"],
        )[:10],
        "by_weekday": [
            {
                "day": weekday_names[i],
                "shifts": int(by_weekday[i]["shifts"]),
                "gross": round(by_weekday[i]["gross"], 2),
                "hours": round(by_weekday[i]["hours"], 2),
                "per_hour": ratio(by_weekday[i]["gross"], by_weekday[i]["hours"]),
                "net_per_hour": ratio(by_weekday[i]["gross"] - by_weekday[i]["fuel"], by_weekday[i]["hours"]),
            }
            for i in range(7)
        ],
    }


def csv_response(filename, header, rows):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ----------------------------------------------------------------- routes ---

def register_routes(app):
    @app.route("/")
    def index():
        return render_template("index.html")

    # PWA files must be served from the root scope
    @app.route("/manifest.json")
    def manifest():
        return send_from_directory("static", "manifest.json")

    @app.route("/sw.js")
    def service_worker():
        return send_from_directory("static/js", "sw.js")

    @app.errorhandler(ValueError)
    def handle_value_error(err):
        db.session.rollback()
        return bad_request(str(err) or "Invalid value.")

    # ---- Meta ----
    @app.route("/api/meta")
    def meta():
        stores = [
            r[0]
            for r in db.session.query(Trip.store, db.func.count(Trip.id))
            .filter(Trip.store != "")
            .group_by(Trip.store)
            .order_by(db.func.count(Trip.id).desc())
            .limit(50)
        ]
        latest_fill = FuelFill.query.order_by(FuelFill.date.desc(), FuelFill.id.desc()).first()
        return jsonify(
            {
                "offer_types": OFFER_TYPES,
                "expense_categories": EXPENSE_CATEGORIES,
                "vehicle_categories": VEHICLE_CATEGORIES,
                "stores": stores,
                "latest_fill": latest_fill.to_dict() if latest_fill else None,
                "settings": get_settings(),
            }
        )

    # ---- Settings ----
    @app.route("/api/settings", methods=["GET"])
    def read_settings():
        return jsonify(get_settings())

    @app.route("/api/settings", methods=["PUT"])
    def update_settings():
        data = request.get_json() or {}
        updates = {}
        if "mileage_rates" in data:
            updates["mileage_rates"] = {
                str(int(y)): float(r) for y, r in data["mileage_rates"].items() if r not in (None, "")
            }
        for key in ("income_tax_pct", "weekly_goal"):
            if key in data:
                updates[key] = num(data[key], DEFAULT_SETTINGS[key])
        if "week_start" in data:
            updates["week_start"] = int(data["week_start"]) % 7
        if "trip_purpose" in data:
            updates["trip_purpose"] = (data["trip_purpose"] or "").strip() or DEFAULT_SETTINGS["trip_purpose"]
        save_settings(updates)
        return jsonify(get_settings())

    # ---- Shifts ----
    @app.route("/api/shifts", methods=["GET"])
    def list_shifts():
        start, end = date_range_args()
        fuel = FuelLookup()
        return jsonify([s.to_dict(fuel) for s in shifts_between(start, end)])

    @app.route("/api/shifts", methods=["POST"])
    def create_shift():
        data = request.get_json() or {}
        if not data.get("start_time"):
            return bad_request("Start time is required.")
        shift = Shift(start_time=parse_dt(data["start_time"]))
        db.session.add(shift)
        apply_shift_fields(shift, data)
        sync_trips(shift, data.get("trips", []))
        db.session.commit()
        return jsonify(shift.to_dict(FuelLookup())), 201

    @app.route("/api/shifts/<int:shift_id>", methods=["GET"])
    def get_shift(shift_id):
        return jsonify(db.get_or_404(Shift, shift_id).to_dict(FuelLookup()))

    @app.route("/api/shifts/<int:shift_id>", methods=["PUT"])
    def update_shift(shift_id):
        shift = db.get_or_404(Shift, shift_id)
        data = request.get_json() or {}
        apply_shift_fields(shift, data)
        if "trips" in data:
            sync_trips(shift, data["trips"])
        db.session.commit()
        return jsonify(shift.to_dict(FuelLookup()))

    @app.route("/api/shifts/<int:shift_id>", methods=["DELETE"])
    def delete_shift(shift_id):
        db.session.delete(db.get_or_404(Shift, shift_id))
        db.session.commit()
        return "", 204

    # ---- Trips (offers) ----
    @app.route("/api/shifts/<int:shift_id>/trips", methods=["POST"])
    def add_trip(shift_id):
        shift = db.get_or_404(Shift, shift_id)
        trip = Trip(shift=shift)
        apply_trip_fields(trip, request.get_json() or {})
        db.session.add(trip)
        db.session.commit()
        return jsonify(trip.to_dict()), 201

    @app.route("/api/trips/<int:trip_id>", methods=["PUT"])
    def update_trip(trip_id):
        trip = db.get_or_404(Trip, trip_id)
        apply_trip_fields(trip, request.get_json() or {})
        db.session.commit()
        return jsonify(trip.to_dict())

    @app.route("/api/trips/<int:trip_id>", methods=["DELETE"])
    def delete_trip(trip_id):
        db.session.delete(db.get_or_404(Trip, trip_id))
        db.session.commit()
        return "", 204

    # ---- Bonuses ----
    @app.route("/api/bonuses", methods=["GET"])
    def list_bonuses():
        start, end = date_range_args()
        rows = (
            Bonus.query.filter(Bonus.date >= start, Bonus.date <= end)
            .order_by(Bonus.date.desc(), Bonus.id.desc())
            .all()
        )
        return jsonify([b.to_dict() for b in rows])

    def apply_bonus_fields(bonus, data):
        bonus.date = parse_date(data.get("date")) or date.today()
        bonus.amount = num(data.get("amount"), 0)
        bonus.description = (data.get("description") or "").strip()

    @app.route("/api/bonuses", methods=["POST"])
    def create_bonus():
        bonus = Bonus()
        apply_bonus_fields(bonus, request.get_json() or {})
        db.session.add(bonus)
        db.session.commit()
        return jsonify(bonus.to_dict()), 201

    @app.route("/api/bonuses/<int:bonus_id>", methods=["PUT"])
    def update_bonus(bonus_id):
        bonus = db.get_or_404(Bonus, bonus_id)
        apply_bonus_fields(bonus, request.get_json() or {})
        db.session.commit()
        return jsonify(bonus.to_dict())

    @app.route("/api/bonuses/<int:bonus_id>", methods=["DELETE"])
    def delete_bonus(bonus_id):
        db.session.delete(db.get_or_404(Bonus, bonus_id))
        db.session.commit()
        return "", 204

    # ---- Expenses ----
    @app.route("/api/expenses", methods=["GET"])
    def list_expenses():
        start, end = date_range_args()
        rows = (
            Expense.query.filter(Expense.date >= start, Expense.date <= end)
            .order_by(Expense.date.desc(), Expense.id.desc())
            .all()
        )
        return jsonify([e.to_dict() for e in rows])

    def apply_expense_fields(expense, data):
        if data.get("category") not in EXPENSE_CATEGORIES:
            raise ValueError("Pick an expense category.")
        expense.date = parse_date(data.get("date")) or date.today()
        expense.category = data["category"]
        expense.amount = num(data.get("amount"), 0)
        expense.description = (data.get("description") or "").strip()

    @app.route("/api/expenses", methods=["POST"])
    def create_expense():
        expense = Expense()
        apply_expense_fields(expense, request.get_json() or {})
        db.session.add(expense)
        db.session.commit()
        return jsonify(expense.to_dict()), 201

    @app.route("/api/expenses/<int:expense_id>", methods=["PUT"])
    def update_expense(expense_id):
        expense = db.get_or_404(Expense, expense_id)
        apply_expense_fields(expense, request.get_json() or {})
        db.session.commit()
        return jsonify(expense.to_dict())

    @app.route("/api/expenses/<int:expense_id>", methods=["DELETE"])
    def delete_expense(expense_id):
        db.session.delete(db.get_or_404(Expense, expense_id))
        db.session.commit()
        return "", 204

    # ---- Fuel fill-ups ----
    @app.route("/api/fuel", methods=["GET"])
    def list_fuel():
        rows = FuelFill.query.order_by(FuelFill.date.desc(), FuelFill.id.desc()).limit(100).all()
        return jsonify([f.to_dict() for f in rows])

    def apply_fuel_fields(fill, data):
        price, mpg = num(data.get("price_per_gallon")), num(data.get("mpg"))
        if not price or price <= 0:
            raise ValueError("Enter the price per gallon.")
        if not mpg or mpg <= 0:
            raise ValueError("Enter your average MPG.")
        fill.date = parse_date(data.get("date")) or date.today()
        fill.price_per_gallon = price
        fill.mpg = mpg

    @app.route("/api/fuel", methods=["POST"])
    def create_fuel():
        fill = FuelFill()
        apply_fuel_fields(fill, request.get_json() or {})
        db.session.add(fill)
        db.session.commit()
        return jsonify(fill.to_dict()), 201

    @app.route("/api/fuel/<int:fill_id>", methods=["PUT"])
    def update_fuel(fill_id):
        fill = db.get_or_404(FuelFill, fill_id)
        apply_fuel_fields(fill, request.get_json() or {})
        db.session.commit()
        return jsonify(fill.to_dict())

    @app.route("/api/fuel/<int:fill_id>", methods=["DELETE"])
    def delete_fuel(fill_id):
        db.session.delete(db.get_or_404(FuelFill, fill_id))
        db.session.commit()
        return "", 204

    # ---- Stats ----
    @app.route("/api/stats")
    def stats():
        start, end = date_range_args()
        granularity = request.args.get("granularity", "day")
        if granularity not in ("day", "week", "month"):
            granularity = "day"
        if (end - start).days > 800:
            return bad_request("Pick a shorter date range.")
        return jsonify(compute_stats(start, end, granularity))

    # ---- Exports ----
    def export_year():
        year = request.args.get("year", type=int) or date.today().year
        return year, date(year, 1, 1), date(year, 12, 31)

    @app.route("/export/mileage.csv")
    def export_mileage():
        year, start, end = export_year()
        settings = get_settings()
        rows = []
        for s in reversed(shifts_between(start, end)):
            rate = rate_for_year(settings, s.start_time.year)
            rows.append(
                [
                    s.start_time.date().isoformat(),
                    s.start_time.strftime("%H:%M"),
                    s.end_time.strftime("%H:%M") if s.end_time else "",
                    settings["trip_purpose"],
                    s.start_odometer if s.start_odometer is not None else "",
                    s.end_odometer if s.end_odometer is not None else "",
                    s.total_miles,
                    s.miles_source,
                    rate,
                    round(s.total_miles * rate, 2),
                ]
            )
        return csv_response(
            f"mileage-log-{year}.csv",
            ["Date", "Start", "End", "Business purpose", "Start odometer", "End odometer",
             "Miles", "Miles source", "IRS rate", "Deduction"],
            rows,
        )

    @app.route("/export/income.csv")
    def export_income():
        year, start, end = export_year()
        rows = []
        for s in reversed(shifts_between(start, end)):
            for t in s.trips:
                rows.append(
                    [s.start_time.date().isoformat(), "Offer", t.offer_type, t.store, t.deliveries,
                     t.base_pay, t.tip, t.incentive, round(t.total, 2), t.miles or "", t.notes]
                )
        for b in Bonus.query.filter(Bonus.date >= start, Bonus.date <= end).order_by(Bonus.date):
            rows.append([b.date.isoformat(), "Bonus", "", "", "", "", "", b.amount, b.amount, "", b.description])
        rows.sort(key=lambda r: r[0])
        return csv_response(
            f"income-{year}.csv",
            ["Date", "Kind", "Offer type", "Store", "Deliveries", "Base pay", "Tip",
             "Incentive", "Total", "Offer miles", "Notes"],
            rows,
        )

    @app.route("/export/expenses.csv")
    def export_expenses():
        year, start, end = export_year()
        rows = [
            [e.date.isoformat(), e.category, e.amount, e.description,
             "No (covered by mileage rate)" if e.is_vehicle else "Yes"]
            for e in Expense.query.filter(Expense.date >= start, Expense.date <= end).order_by(Expense.date)
        ]
        return csv_response(
            f"expenses-{year}.csv",
            ["Date", "Category", "Amount", "Description", "Deductible w/ standard mileage"],
            rows,
        )

    @app.route("/export/backup.db")
    def export_backup():
        path = os.path.join(app.instance_path, "spark_tracker.db")
        return send_file(
            path,
            as_attachment=True,
            download_name=f"spark-tracker-backup-{date.today().isoformat()}.db",
        )


app = create_app()

if __name__ == "__main__":
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    port = int(os.environ.get("PORT", "5052"))
    app.run(host=host, port=port, debug=debug)
