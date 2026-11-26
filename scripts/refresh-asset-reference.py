"""Refresh source-linked U.S. property indices and recent fleet sales used by the inventory."""
import csv
import io
import json
import re
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

FHFA = "https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_po_state.txt"
AUCTIONS = "https://uxsearch.app/research/data/government-auction-sales.csv"
OUTPUT = Path(__file__).resolve().parents[1] / "apps/web/public/asset-reference.json"
MAKES = ("acura", "audi", "bmw", "buick", "cadillac", "chevrolet", "chrysler", "dodge", "fiat",
         "ford", "genesis", "gmc", "honda", "hyundai", "infiniti", "jaguar", "jeep", "kia", "lexus",
         "lincoln", "mazda", "mercedes", "mercury", "mini", "mitsubishi", "nissan", "pontiac",
         "ram", "rivian", "saturn", "subaru", "tesla", "toyota", "volkswagen", "volvo")
VEHICLE = re.compile(r"^(?:MY\s*)?((?:19|20)\d\d)\s+(" + "|".join(MAKES) + r")\s+([\w-]+)", re.I)
EXCLUDE = re.compile(r"\b(salvage|parts?|repair|wreck|damaged?|inoperable|crash|accident|junk|lot|"
                     r"non[ -]?running|does not run|as[ -]is non|not running|scrap|flood|seized parts)\b", re.I)


def read_rows(url, separator=","):
    req = Request(url, headers={"User-Agent": "BudgetHQPro asset research"})
    with urlopen(req, timeout=120) as response:
        yield from csv.DictReader(io.TextIOWrapper(response, encoding="utf-8-sig"), delimiter=separator)


def main():
    indices = defaultdict(dict)
    for row in read_rows(FHFA, "\t"):
        if not re.fullmatch(r"[A-Z]{2}", row["state"]):
            continue
        try:
            index = int(round(100 * float(row["indx_nsa"])))
            quarter = int(row["yr"]) * 4 + int(row["qtr"]) - 1
        except ValueError:
            continue
        if index > 0:
            indices[row["state"]][quarter] = index

    # One row per official GovDeals result. Retain recent comparable units without storing seller information.
    vehicles = defaultdict(dict)
    cutoff = (date.today() - timedelta(days=365)).isoformat()
    for row in read_rows(AUCTIONS):
        title = row["item"].strip()
        match = VEHICLE.match(title)
        listing = re.fullmatch(r"https://www\.govdeals\.com/(?:en/)?asset/(\d+/\d+)/?", row["official_listing"])
        if not match or not listing or not (cutoff <= row["sold_date"] <= date.today().isoformat()) or EXCLUDE.search(title):
            continue
        if str(row["model_year"]) != match[1] or len(title) > 150:
            continue
        try:
            cents = round(float(row["final_price_usd"]) * 100)
        except ValueError:
            continue
        if not 0 < cents <= 999999999999:
            continue
        key = (match[1], match[2].lower(), match[3].lower())
        vehicles[key][listing[1]] = [row["sold_date"], title, cents, listing[1]]
    sales = [sale for key in sorted(vehicles) for sale in sorted(vehicles[key].values(), reverse=True)[:10]]
    series = {}
    for state, quarters in sorted(indices.items()):
        start, end = min(quarters), max(quarters)
        series[state] = [start, [quarters.get(n) for n in range(start, end + 1)]]
    if len(series) < 50 or len(sales) < 1500:
        raise ValueError("Incomplete source data; the previous reference file is preserved.")
    data = {"fhfa": series, "vehicles": sales}
    # Break between sale rows so individual corrections are reviewable.
    out = '{"fhfa":' + json.dumps(series, separators=(",", ":")) + ',"vehicles":[\n'
    out += ",\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in data["vehicles"]) + "]}\n"
    tmp = OUTPUT.with_suffix(".tmp")
    tmp.write_text(out, encoding="utf-8")
    tmp.replace(OUTPUT)
    print(f"Refreshed {len(series)} state index series and {len(sales)} source-linked fleet auction sales.")


if __name__ == "__main__":
    main()
