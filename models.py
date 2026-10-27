import copy
import json
from datetime import datetime

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

OFFER_TYPES = ["Curbside", "Shop & Deliver", "Express", "Return", "Other"]

# Under the IRS standard mileage rate, vehicle operating costs (gas, repairs,
# insurance, washes) are already baked into the per-mile rate and can't be
# deducted separately. Parking, tolls, phone, and supplies still can.
# Gas isn't an expense category: it's estimated from Spark miles via FuelFill,
# so personal driving never inflates the numbers.
VEHICLE_CATEGORIES = ["Maintenance & Repairs", "Car Wash", "Insurance"]
OTHER_CATEGORIES = ["Parking & Tolls", "Phone & Data", "Supplies", "Other"]
EXPENSE_CATEGORIES = VEHICLE_CATEGORIES + OTHER_CATEGORIES

DEFAULT_SETTINGS = {
    # IRS business standard mileage rates ($/mile). Editable in Settings.
    "mileage_rates": {"2024": 0.67, "2025": 0.70, "2026": 0.725},
    "income_tax_pct": 10,  # rough federal+state income tax set-aside on profit
    "week_start": 0,  # 0 = Monday ... 6 = Sunday
    "weekly_goal": 0,
    "trip_purpose": "Walmart Spark deliveries",
}


class Shift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    start_time = db.Column(db.DateTime, nullable=False)
    end_time = db.Column(db.DateTime)
    start_odometer = db.Column(db.Float)
    end_odometer = db.Column(db.Float)
    miles = db.Column(db.Float)  # manual miles when odometer isn't logged
    notes = db.Column(db.Text, default="")
    trips = db.relationship(
        "Trip", backref="shift", cascade="all, delete-orphan", order_by="Trip.id"
    )

    @property
    def is_active(self):
        return self.end_time is None

    @property
    def total_miles(self):
        if (
            self.start_odometer is not None
            and self.end_odometer is not None
            and self.end_odometer >= self.start_odometer
        ):
            return round(self.end_odometer - self.start_odometer, 1)
        if self.miles is not None:
            return self.miles
        return round(sum(t.miles or 0 for t in self.trips), 1)

    @property
    def miles_source(self):
        if (
            self.start_odometer is not None
            and self.end_odometer is not None
            and self.end_odometer >= self.start_odometer
        ):
            return "odometer"
        if self.miles is not None:
            return "manual"
        return "trips"

    @property
    def hours(self):
        end = self.end_time or datetime.now()
        return max((end - self.start_time).total_seconds() / 3600, 0)

    @property
    def gross(self):
        return round(sum(t.total for t in self.trips), 2)

    def to_dict(self, fuel=None):
        fuel_cost = fuel.cost(self.start_time.date(), self.total_miles) if fuel else None
        return {
            "id": self.id,
            "fuel_cost": round(fuel_cost, 2) if fuel_cost is not None else None,
            "start_time": self.start_time.isoformat(timespec="minutes"),
            "end_time": self.end_time.isoformat(timespec="minutes") if self.end_time else None,
            "start_odometer": self.start_odometer,
            "end_odometer": self.end_odometer,
            "miles": self.miles,
            "total_miles": self.total_miles,
            "miles_source": self.miles_source,
            "hours": round(self.hours, 2),
            "gross": self.gross,
            "tips": round(sum(t.tip or 0 for t in self.trips), 2),
            "notes": self.notes or "",
            "is_active": self.is_active,
            "trips": [t.to_dict() for t in self.trips],
        }


class Trip(db.Model):
    """One accepted Spark offer (may contain several deliveries if batched)."""

    id = db.Column(db.Integer, primary_key=True)
    shift_id = db.Column(db.Integer, db.ForeignKey("shift.id"), nullable=False)
    offer_type = db.Column(db.String(40), default="Curbside")
    store = db.Column(db.String(120), default="")
    base_pay = db.Column(db.Float, default=0)
    tip = db.Column(db.Float, default=0)
    incentive = db.Column(db.Float, default=0)
    miles = db.Column(db.Float)  # offer's estimated miles, for $/mile analysis
    deliveries = db.Column(db.Integer, default=1)
    notes = db.Column(db.Text, default="")
    created_at = db.Column(db.DateTime, default=datetime.now)

    @property
    def total(self):
        return (self.base_pay or 0) + (self.tip or 0) + (self.incentive or 0)

    def to_dict(self):
        return {
            "id": self.id,
            "shift_id": self.shift_id,
            "offer_type": self.offer_type,
            "store": self.store or "",
            "base_pay": self.base_pay or 0,
            "tip": self.tip or 0,
            "incentive": self.incentive or 0,
            "miles": self.miles,
            "deliveries": self.deliveries or 1,
            "notes": self.notes or "",
            "total": round(self.total, 2),
            "created_at": self.created_at.isoformat(timespec="minutes") if self.created_at else None,
        }


class Bonus(db.Model):
    """Income not tied to a single offer: weekly challenges, referral bonuses, adjustments."""

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    amount = db.Column(db.Float, nullable=False)
    description = db.Column(db.String(200), default="")

    def to_dict(self):
        return {
            "id": self.id,
            "date": self.date.isoformat(),
            "amount": self.amount,
            "description": self.description or "",
        }


class Expense(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    category = db.Column(db.String(60), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    description = db.Column(db.String(200), default="")

    @property
    def is_vehicle(self):
        return self.category in VEHICLE_CATEGORIES

    def to_dict(self):
        return {
            "id": self.id,
            "date": self.date.isoformat(),
            "category": self.category,
            "amount": self.amount,
            "description": self.description or "",
            "is_vehicle": self.is_vehicle,
        }


class FuelFill(db.Model):
    """Gas price and the car's average MPG as of a fill-up. A shift's gas cost
    uses the most recent fill on or before its date."""

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    price_per_gallon = db.Column(db.Float, nullable=False)
    mpg = db.Column(db.Float, nullable=False)

    @property
    def cost_per_mile(self):
        return self.price_per_gallon / self.mpg if self.mpg else 0

    def to_dict(self):
        return {
            "id": self.id,
            "date": self.date.isoformat(),
            "price_per_gallon": self.price_per_gallon,
            "mpg": self.mpg,
            "cost_per_mile": round(self.cost_per_mile, 4),
        }


class FuelLookup:
    """Loads fill-ups once and answers "gas cost per mile on this day"."""

    def __init__(self):
        self.fills = FuelFill.query.order_by(FuelFill.date, FuelFill.id).all()

    def fill_for(self, day):
        if not self.fills:
            return None
        prior = [f for f in self.fills if f.date <= day]
        # Shifts before the first logged fill use the earliest one we know.
        return prior[-1] if prior else self.fills[0]

    def cost(self, day, miles):
        fill = self.fill_for(day)
        if fill is None or not miles:
            return 0.0 if fill else None
        return miles * fill.cost_per_mile


class Setting(db.Model):
    key = db.Column(db.String(60), primary_key=True)
    value = db.Column(db.Text, nullable=False)  # JSON-encoded


def get_settings():
    settings = copy.deepcopy(DEFAULT_SETTINGS)
    for row in Setting.query.all():
        settings[row.key] = json.loads(row.value)
    return settings


def save_settings(updates):
    for key, value in updates.items():
        if key not in DEFAULT_SETTINGS:
            continue
        row = db.session.get(Setting, key)
        if row is None:
            row = Setting(key=key, value="null")
            db.session.add(row)
        row.value = json.dumps(value)
    db.session.commit()


def rate_for_year(settings, year):
    rates = settings.get("mileage_rates") or {}
    if not rates:
        return 0.0
    if str(year) in rates:
        return float(rates[str(year)])
    # Fall back to the closest earlier year (or the latest one we know).
    years = sorted(int(y) for y in rates)
    prior = [y for y in years if y <= year]
    return float(rates[str(prior[-1] if prior else years[-1])])
