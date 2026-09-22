#!/usr/bin/env python3
"""Genere les fixtures de parite a partir du script Python d'origine.

Le portage JavaScript est ensuite compare a ces sorties, fonction par
fonction. C'est la seule facon de prouver que le site calcule la meme chose
que la version locale, plutot que quelque chose de plausible.

Usage : python3 tests/parite.py ../genere_boucle.py tests/fixtures
"""
import importlib.util
import itertools
import json
import os
import random
import sys


def charge(chemin):
    spec = importlib.util.spec_from_file_location("origine", chemin)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cas_de_tags():
    """Combinaisons de tags couvrant chaque branche de evalue_voie."""
    cas = []

    # Un cas par type de voie connu et par type interdit.
    for hw in sorted(set(list(ORIGINE.COUT_BASE) + list(ORIGINE.HW_INTERDITS)
                         + ["", "unknown_type"])):
        cas.append({"highway": hw})

    # Chaque tag bloquant, isole, sur une voie ordinaire et sur un sentier.
    bloquants = [
        ("area", "yes"), ("indoor", "yes"), ("level", "0"), ("level", "-1"),
        ("foot", "no"), ("foot", "private"), ("foot", "destination"),
        ("foot", "yes"), ("foot", "designated"), ("foot", "permissive"),
        ("access", "no"), ("access", "private"), ("access", "customers"),
        ("access", "permit"), ("access", "military"), ("access", "delivery"),
        ("access", "agricultural"), ("access", "forestry"), ("access", "yes"),
        ("service", "driveway"), ("service", "parking_aisle"),
        ("service", "alley"), ("service", "drive-through"),
        ("service", "emergency_access"), ("service", "slipway"),
        ("ford", "yes"), ("ford", "stepping_stones"), ("ford", "no"),
        ("overgrown", "yes"), ("seasonal", "spring"), ("seasonal", "no"),
        ("obstacle", "vegetation"), ("obstacle", "log"),
        ("obstacle", "fallen_tree"), ("obstacle", "gate"),
        ("flooded", "yes"), ("informal", "yes"), ("abandoned", "yes"),
        ("disused", "yes"),
        ("trail_visibility", "bad"), ("trail_visibility", "horrible"),
        ("trail_visibility", "no"), ("trail_visibility", "intermediate"),
        ("trail_visibility", "excellent"), ("trail_visibility", "good"),
        ("sac_scale", "hiking"), ("sac_scale", "mountain_hiking"),
        ("smoothness", "horrible"), ("smoothness", "very_horrible"),
        ("smoothness", "impassable"), ("smoothness", "bad"),
        ("smoothness", "very_bad"), ("smoothness", "intermediate"),
        ("smoothness", "excellent"), ("smoothness", "good"),
        ("tracktype", "grade1"), ("tracktype", "grade2"), ("tracktype", "grade3"),
        ("tracktype", "grade4"), ("tracktype", "grade5"),
        ("width", "0.4"), ("width", "0,5 m"), ("width", "2"), ("width", "1.5m"),
        ("width", "large"), ("est_width", "0.3"), ("est_width", "3"),
        ("name", "Sentier des Douaniers"), ("lit", "yes"), ("lit", "no"),
        ("bicycle", "designated"), ("bicycle", "yes"), ("bicycle", "no"),
        ("sidewalk", "no"), ("sidewalk", "none"), ("sidewalk", "both"),
        ("maxspeed", "30"), ("maxspeed", "70"), ("maxspeed", "90"),
        ("maxspeed", "50 mph"), ("maxspeed", "walk"),
    ]
    for hw in ("footway", "path", "track", "residential", "service",
               "secondary", "tertiary", "bridleway", "steps"):
        for cle, valeur in bloquants:
            cas.append({"highway": hw, cle: valeur})

    # Toutes les surfaces, sur une voie naturelle et une voie de voirie.
    surfaces = sorted(ORIGINE.SURFACES_DURES | ORIGINE.SURFACES_MEUBLES
                      | ORIGINE.SURFACES_RISQUEES | ORIGINE.SURFACES_INTERDITES
                      | {"inconnue_totale"})
    for hw in ("path", "track", "footway", "residential"):
        for surface in surfaces:
            cas.append({"highway": hw, "surface": surface})

    # Combinaisons a deux et trois tags, tirees au hasard mais reproductibles :
    # c'est ce qui attrape les interactions entre regles.
    alea = random.Random(20260915)
    cles = bloquants + [("surface", s) for s in surfaces]
    for _ in range(1200):
        tags = {"highway": alea.choice(["footway", "path", "track", "residential",
                                        "service", "secondary", "tertiary",
                                        "cycleway", "pedestrian", "steps"])}
        for cle, valeur in alea.sample(cles, alea.randint(1, 3)):
            tags[cle] = valeur
        cas.append(tags)

    return cas


def dump_evalue_voie():
    resultats = []
    for tags in cas_de_tags():
        for niveau in ("strict", "normal", "tolerant"):
            for balise in (False, True):
                verdict = ORIGINE.evalue_voie(tags, niveau, balise)
                resultats.append({
                    "tags": tags, "niveau": niveau, "balise": balise,
                    "verdict": None if verdict is None
                               else [verdict[0], verdict[1], verdict[2]],
                })
    return resultats


def dump_geometrie():
    alea = random.Random(4242)
    resultats = []
    for _ in range(2000):
        lat1 = alea.uniform(-84, 84)
        lon1 = alea.uniform(-179, 179)
        lat2 = alea.uniform(-84, 84)
        lon2 = alea.uniform(-179, 179)
        cap = alea.uniform(0, 360)
        distance = alea.uniform(1, 40000)
        resultats.append({
            "entree": [lat1, lon1, lat2, lon2, cap, distance],
            "haversine": ORIGINE.distance_haversine(lat1, lon1, lat2, lon2),
            "cap": ORIGINE.cap_entre(lat1, lon1, lat2, lon2),
            "point": list(ORIGINE.point_a_distance(lat1, lon1, cap, distance)),
            "boite": ORIGINE.boite_englobante(lat1, lon1, distance),
        })
    return resultats


def dump_nombre():
    valeurs = ["1.5", "1,5 m", "2", "", " ", "1.5m", "abc", "3 m", "-2.5",
               "+4", ".5", "5.", "1e3", "12,7", "0.4", "grade3", "walk",
               "50 mph", "none", "0", "-0.0", "  7  ", "1 2 3"]
    return [{"valeur": v, "resultat": ORIGINE._nombre(v)} for v in valeurs]


def dump_arrondi():
    valeurs = [-2.5, -1.5, -0.5, 0.0, 0.5, 1.5, 2.5, 3.5, 0.4999, 0.5001,
               1.2, 1.8, 199.5, 200.5, 12.5, 13.5]
    return [{"valeur": v, "resultat": round(v)} for v in valeurs]


def dump_note_boucle():
    alea = random.Random(7)
    cas = []
    for _ in range(400):
        longueur = alea.uniform(1000, 30000)
        repetee = alea.uniform(0, longueur * 0.4)
        cible = alea.uniform(1000, 30000)
        virages = alea.uniform(0, 6)
        note = ORIGINE.note_boucle(longueur, repetee, cible, 0.03, virages)
        cas.append({"entree": [longueur, repetee, cible, 0.03, virages],
                    "note": list(note)})
    # Ordre relatif deux a deux : c'est le classement qui compte, pas la note.
    paires = []
    for _ in range(400):
        a = alea.randrange(len(cas))
        b = alea.randrange(len(cas))
        na = tuple(cas[a]["note"])
        nb = tuple(cas[b]["note"])
        paires.append({"a": a, "b": b,
                       "ordre": -1 if na < nb else (1 if na > nb else 0)})
    return {"notes": cas, "paires": paires}


def dump_allege():
    cas = []
    for taille, maximum in [(10, 100), (100, 10), (3000, 3000), (5000, 3000),
                            (7, 3), (1, 1), (9, 4)]:
        points = [[45.0 + i * 1e-4, 1.0 + i * 1e-4] for i in range(taille)]
        cas.append({"taille": taille, "maximum": maximum,
                    "resultat": ORIGINE.allege(list(points), maximum)})
    return cas


def reseau_fabrique():
    """Petite ville en damier, avec de quoi exercer chaque regle.

    Pas de donnees reelles : un reseau fabrique est reproductible, tient dans
    le depot, et permet de faire tourner l'algorithme complet sans reseau.
    """
    voies = []
    identifiant = itertools.count(1000)
    noeud = itertools.count(500000)
    grille = {}
    n, pas = 13, 0.0016          # ~13 x 13 rues espacees de ~175 m

    for i in range(n):
        for j in range(n):
            grille[(i, j)] = (next(noeud), 47.0 + i * pas, 5.0 + j * pas)

    def ajoute(points, tags):
        voies.append({
            "type": "way", "id": next(identifiant), "tags": tags,
            "nodes": [p[0] for p in points],
            "geometry": [{"lat": p[1], "lon": p[2]} for p in points],
        })

    for i in range(n):
        ajoute([grille[(i, j)] for j in range(n)],
               {"highway": "residential" if i % 3 else "footway",
                "surface": "asphalt"})
    for j in range(n):
        ajoute([grille[(i, j)] for i in range(n)],
               {"highway": "residential" if j % 4 else "cycleway",
                "surface": "asphalt"})

    # Impasses accrochees au damier : elles doivent disparaitre au 2-coeur.
    for k in range(6):
        depart = grille[(2 + k, 3)]
        bout = (next(noeud), depart[1] + 0.0004, depart[2] - 0.0009)
        ajoute([depart, bout], {"highway": "service", "surface": "asphalt"})

    # Voies qui doivent etre refusees : le trace ne doit jamais les emprunter.
    interdites = []
    for k in range(5):
        a, b = grille[(k, 10)], grille[(k, 11)]
        milieu = (next(noeud), (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
        interdites.append(milieu[0])
        ajoute([a, milieu, b], {"highway": "motorway"})
        ajoute([a, milieu], {"highway": "footway", "foot": "no"})
        ajoute([milieu, b], {"highway": "path", "informal": "yes"})

    return voies, sorted(set(interdites))


def traces_types():
    """Traces fabriques couvrant chaque cas du controle geometrique."""
    cos47 = 0.6819983600624985          # cos(47 deg), fige pour la stabilite
    dlat = lambda m: m / 111320.0
    dlon = lambda m: m / 111320.0 / cos47

    def carre(cote=800, pas=20):
        p, n = [], cote // pas
        for k in range(n + 1):
            p.append([47.0, 5.0 + dlon(k * pas)])
        for k in range(1, n + 1):
            p.append([47.0 + dlat(k * pas), 5.0 + dlon(cote)])
        for k in range(1, n + 1):
            p.append([47.0 + dlat(cote), 5.0 + dlon(cote - k * pas)])
        for k in range(1, n + 1):
            p.append([47.0 + dlat(cote - k * pas), 5.0])
        return p

    traces = {}
    traces["carre"] = carre()
    traces["carre_ferme"] = carre() + [carre()[0]]

    # Aller par la rue, retour par le trottoir douze metres a cote.
    t = carre()[:20]
    t += [[47.0 - dlat(k * 19), 5.0 + dlon(380)] for k in range(1, 9)]
    t += [[47.0 - dlat(k * 19), 5.0 + dlon(392)] for k in range(8, 0, -1)]
    t += carre()[20:]
    traces["rue_puis_trottoir"] = t

    # Demi-tour franc sur la meme voie.
    traces["demi_tour"] = carre() + carre()[:20]

    # Crochet ferme sur lui-meme au milieu du parcours : la bouclette.
    t = carre()[:15]
    base = t[-1]
    for k in range(1, 6):
        t.append([base[0] - dlat(k * 30), base[1]])
    for k in range(1, 6):
        t.append([base[0] - dlat(150), base[1] + dlon(k * 30)])
    for k in range(1, 6):
        t.append([base[0] - dlat(150 - k * 30), base[1] + dlon(150)])
    for k in range(1, 6):
        t.append([base[0], base[1] + dlon(150 - k * 30)])
    t += carre()[15:]
    traces["bouclette"] = t

    # Trop court pour que la mesure ait un sens.
    traces["minuscule"] = [[47.0, 5.0], [47.0, 5.001]]
    return traces


def dump_controle():
    """Mesures geometriques sur des traces types, pour verrouiller la parite.

    Le site applique exactement le meme controle que le script : sans ces
    references, les deux implementations pourraient diverger sans bruit.
    """
    cas = []
    for nom, points in sorted(traces_types().items()):
        doublement = ORIGINE.mesure_doublement(points)
        bouclettes = ORIGINE.mesure_bouclettes(points)
        cas.append({
            "nom": nom,
            "points": points,
            "doublement": doublement["longueur"],
            "nb_portions": len(doublement["portions"]),
            "bouclettes": bouclettes["longueur"],
            "nb_bouclettes": bouclettes["nombre"],
        })
    return cas


def dump_bout_en_bout(voies):
    """Fait tourner genere() sur le reseau fabrique, sans toucher au reseau."""
    ORIGINE.telecharge_reseau = lambda *a, **k: voies
    ORIGINE.telecharge_itineraires = lambda *a, **k: set()
    ORIGINE.telecharge_barrieres = lambda *a, **k: []

    cas = []
    for km in (3.0, 5.0, 8.0):
        for niveau in ("normal", "tolerant"):
            try:
                r = ORIGINE.genere(47.0096, 5.0096, km * 1000.0, niveau=niveau,
                                   caps=8, sommets=(3, 4), iterations=8,
                                   journal=lambda *a: None)
                cas.append({
                    "km": km, "niveau": niveau, "ok": True,
                    "distance": r["distance"], "repetee": r["repetee"],
                    "part_repetee": r["part_repetee"],
                    "nb_points": len(r["points"]),
                    "premier": list(r["points"][0]),
                    "dernier": list(r["points"][-1]),
                })
            except Exception as erreur:
                cas.append({"km": km, "niveau": niveau, "ok": False,
                            "erreur": type(erreur).__name__})
    return cas


if __name__ == "__main__":
    chemin_script = sys.argv[1]
    dossier = sys.argv[2]
    ORIGINE = charge(chemin_script)
    os.makedirs(dossier, exist_ok=True)

    voies, interdites = reseau_fabrique()

    fichiers = {
        "evalue_voie.json": dump_evalue_voie(),
        "geometrie.json": dump_geometrie(),
        "nombre.json": dump_nombre(),
        "arrondi.json": dump_arrondi(),
        "note_boucle.json": dump_note_boucle(),
        "allege.json": dump_allege(),
        "reseau.json": {"voies": voies, "noeuds_interdits": interdites},
        "controle.json": dump_controle(),
        "bout_en_bout.json": dump_bout_en_bout(voies),
    }
    for nom, contenu in fichiers.items():
        with open(os.path.join(dossier, nom), "w", encoding="utf-8") as f:
            json.dump(contenu, f)
        print("{:<20} {:>8} octets".format(
            nom, os.path.getsize(os.path.join(dossier, nom))))
