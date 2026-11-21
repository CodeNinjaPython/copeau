"""Génère peche_reunion.json, peche_reunion.sqlite et csv/*.csv depuis data.py."""
import csv
import json
import sqlite3
from pathlib import Path

import data

ICI = Path(__file__).parent


def lst(v):
    return "; ".join(map(str, v)) if isinstance(v, list) else v


def main():
    glossaire = [{"terme": t, "definition": d} for t, d in data.GLOSSAIRE]
    db = {
        "mise_a_jour": data.MISE_A_JOUR,
        "sources": data.SOURCES, "techniques": data.TECHNIQUES, "especes": data.ESPECES,
        "zones": data.ZONES, "regles": data.REGLES, "calendrier": data.CALENDRIER,
        "glossaire": glossaire, "chiffres": data.CHIFFRES,
    }

    # Contrôle d'intégrité des références
    ids = {k: {r["id"] for r in db[k]} for k in ("sources", "techniques", "especes", "zones")}
    for t in data.TECHNIQUES:
        for e in t["especes"]:
            assert e in ids["especes"], (t["id"], e)
        for z in t["zones"]:
            assert z in ids["zones"], (t["id"], z)
    for table in ("techniques", "especes", "zones", "regles", "chiffres"):
        for r in db[table]:
            for s in r.get("sources", []):
                assert s in ids["sources"], (table, r, s)

    (ICI / "peche_reunion.json").write_text(json.dumps(db, ensure_ascii=False, indent=1), encoding="utf-8")

    # Explorateur HTML autonome (données embarquées)
    tpl = (ICI / "explorateur.template.html").read_text(encoding="utf-8")
    blob = json.dumps(db, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    (ICI / "explorateur.html").write_text(tpl.replace("/*DATA*/null", blob), encoding="utf-8")

    # CSV
    out = ICI / "csv"
    out.mkdir(exist_ok=True)
    for table in ("sources", "techniques", "especes", "zones", "regles", "calendrier", "glossaire", "chiffres"):
        rows = db[table]
        cols = list(rows[0].keys())
        with open(out / f"{table}.csv", "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=cols, delimiter=";")
            w.writeheader()
            for r in rows:
                w.writerow({c: lst(r.get(c)) for c in cols})

    # SQLite
    path = ICI / "peche_reunion.sqlite"
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    c = con.cursor()
    c.executescript("""
    CREATE TABLE source (id TEXT PRIMARY KEY, titre TEXT, editeur TEXT, annee INTEGER, url TEXT);
    CREATE TABLE technique (id TEXT PRIMARY KEY, nom TEXT, nom_local TEXT, categorie TEXT, milieu TEXT,
        description TEXT, materiel TEXT, saison TEXT, reglementation TEXT, fiabilite TEXT);
    CREATE TABLE espece (id TEXT PRIMARY KEY, nom TEXT, nom_local TEXT, scientifique TEXT, groupe TEXT, milieu TEXT,
        statut TEXT, taille_min TEXT, periode TEXT, ciguatera INTEGER, notes TEXT, fiabilite TEXT);
    CREATE TABLE zone (id TEXT PRIMARY KEY, nom TEXT, type TEXT, commune TEXT, secteur TEXT, lat REAL, lon REAL,
        description TEXT, reglementation TEXT, fiabilite TEXT);
    CREATE TABLE regle (id TEXT PRIMARY KEY, theme TEXT, public TEXT, regle TEXT, fiabilite TEXT);
    CREATE TABLE technique_espece (technique_id TEXT REFERENCES technique(id), espece_id TEXT REFERENCES espece(id));
    CREATE TABLE technique_zone (technique_id TEXT REFERENCES technique(id), zone_id TEXT REFERENCES zone(id));
    CREATE TABLE reference (objet_type TEXT, objet_id TEXT, source_id TEXT REFERENCES source(id));
    CREATE TABLE calendrier (sujet TEXT, mois INTEGER, type TEXT, fiabilite TEXT);
    CREATE TABLE glossaire (terme TEXT PRIMARY KEY, definition TEXT);
    CREATE TABLE chiffre (indicateur TEXT, valeur TEXT, annee INTEGER, source_id TEXT);
    """)
    for s in data.SOURCES:
        c.execute("INSERT INTO source VALUES (?,?,?,?,?)", (s["id"], s["titre"], s["editeur"], s["annee"], s["url"]))
    for t in data.TECHNIQUES:
        c.execute("INSERT INTO technique VALUES (?,?,?,?,?,?,?,?,?,?)", (t["id"], t["nom"], t["nom_local"], t["categorie"],
                  t["milieu"], t["description"], t["materiel"], t["saison"], t["reglementation"], t["fiabilite"]))
        c.executemany("INSERT INTO technique_espece VALUES (?,?)", [(t["id"], e) for e in t["especes"]])
        c.executemany("INSERT INTO technique_zone VALUES (?,?)", [(t["id"], z) for z in t["zones"]])
    for e in data.ESPECES:
        c.execute("INSERT INTO espece VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (e["id"], e["nom"], e["nom_local"], e["scientifique"],
                  e["groupe"], e["milieu"], e["statut"], e["taille_min"], e["periode"], int(e["ciguatera"]), e["notes"], e["fiabilite"]))
    for z in data.ZONES:
        c.execute("INSERT INTO zone VALUES (?,?,?,?,?,?,?,?,?,?)", (z["id"], z["nom"], z["type"], z["commune"], z["secteur"],
                  z["lat"], z["lon"], z["description"], z["reglementation"], z["fiabilite"]))
    for r in data.REGLES:
        c.execute("INSERT INTO regle VALUES (?,?,?,?,?)", (r["id"], r["theme"], r["public"], r["regle"], r["fiabilite"]))
    for kind, rows in (("technique", data.TECHNIQUES), ("espece", data.ESPECES), ("zone", data.ZONES), ("regle", data.REGLES)):
        for r in rows:
            c.executemany("INSERT INTO reference VALUES (?,?,?)", [(kind, r["id"], s) for s in r["sources"]])
    for k in data.CALENDRIER:
        c.executemany("INSERT INTO calendrier VALUES (?,?,?,?)", [(k["sujet"], m, k["type"], k["fiabilite"]) for m in k["mois"]])
    c.executemany("INSERT INTO glossaire VALUES (?,?)", data.GLOSSAIRE)
    for k in data.CHIFFRES:
        c.execute("INSERT INTO chiffre VALUES (?,?,?,?)", (k["indicateur"], k["valeur"], k["annee"], lst(k["sources"])))
    con.commit()
    counts = {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("technique", "espece", "zone", "regle", "source")}
    con.close()
    print("OK", counts)


if __name__ == "__main__":
    main()
