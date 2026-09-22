# genere-boucle

Génère une boucle de course à pied d'une distance donnée, départ et arrivée au même point, en n'empruntant **que** des voies que les données OpenStreetMap décrivent comme praticables à pied. Le filtrage porte sur les données, pas sur le terrain : une carte peut être incomplète ou datée, l'itinéraire reste à vérifier avant de le courir.

Deux façons de s'en servir, le même algorithme derrière :

- **[Le site](https://mevennou.github.io/genere-boucle/)** — rien à installer, rien à créer. Tout le calcul se fait dans votre navigateur.
- **Le script Python** — un seul fichier, aucune dépendance, pour ceux qui préfèrent la ligne de commande ou travailler hors ligne.

Sortie en GPX standard, importable dans COROS, Garmin, Suunto, Strava, Komoot…

![Tests](https://github.com/mevennou/genere-boucle/actions/workflows/tests.yml/badge.svg)
![Licence MIT](https://img.shields.io/badge/licence-MIT-green)

## Le principe

Ce n'est pas un simple appel à un serveur de routage.

1. Le réseau OpenStreetMap réel autour du départ est téléchargé via Overpass.
2. Le graphe piétonnier est **construit ici**, et n'accueille que les voies dont les tags OSM attestent la praticabilité. Un sentier broussailleux, une trace informelle, un gué, une voie privée n'existent tout simplement pas dans le graphe : l'itinéraire ne peut pas y passer. C'est une garantie structurelle, pas une pénalité qu'une bonne distance pourrait compenser.
3. Toutes les impasses sont supprimées (réduction dite « 2-cœur » : retrait itératif des nœuds n'ayant qu'un seul voisin). Plus d'antenne sans issue, donc plus d'aller-retour ni de demi-tour.
4. La boucle est cherchée par un polygone d'ancres (3 à 6 sommets) autour du départ, chaque tronçon calculé en A\* avec une forte pénalité sur les arêtes déjà empruntées : la distance cible est atteinte en **élargissant** la boucle, jamais en ajoutant des va-et-vient.
5. Une rue et son trottoir cartographié à part sont deux arêtes distinctes du graphe, mais une seule voie sur le terrain : elles sont regroupées en **couloirs**, pour qu'aller par l'une et revenir par l'autre compte comme un aller-retour. Quand les deux bords d'une chaussée sont cartographiés, le couloir sait lequel est à gauche du sens de la course : le bord droit est légèrement renchéri, comme le demande le code de la route hors agglomération. C'est une préférence, pas une interdiction — traverser deux fois pour changer de trottoir ne vaudrait pas la règle.
6. Le tracé retenu subit enfin un **contrôle géométrique**, sur le dessin obtenu et non sur le graphe. Il mesure deux défauts que le comptage par arête ne peut pas voir : la longueur qui longe une autre portion du parcours (aller par la rue, revenir par le trottoir), et les **petites boucles** refermées sur elles-mêmes — un crochet qui fait le tour d'un pâté de maisons et revient au même carrefour n'emprunte aucune arête deux fois. Plusieurs dizaines de candidats sont examinés, du meilleur au moins bon ; le premier tracé net l'emporte. Un repli ne peut pas coûter plus d'un cinquième de la distance demandée, sans quoi le plus court chemin direct — qui ne double rien puisqu'il ne fait aucun détour — finirait par gagner. Si aucun candidat n'est net, le défaut restant est annoncé plutôt que tu.

## Le site

Hébergé sur GitHub Pages, donc statique : il n'y a aucun serveur de calcul. Le navigateur télécharge le réseau OSM, construit le graphe et cherche la boucle sur la machine du visiteur, dans un *web worker* pour que la carte reste manipulable pendant la recherche. Conséquence heureuse : la charge reste diffuse sur les serveurs bénévoles d'OpenStreetMap, puisque chaque visiteur interroge Overpass depuis chez lui.

Le portage JavaScript est environ **neuf fois plus rapide** que la version Python à résultat identique, parce qu'il travaille sur des indices denses et des tableaux typés plutôt que sur des tables de hachage indexées par identifiants OSM, et qu'il réutilise ses tableaux de travail d'un appel d'A\* au suivant.

L'interface s'adapte au téléphone : le panneau devient une feuille que l'on replie d'un geste pour dégager la carte, le bouton de génération reste ancré en bas de cette feuille quel que soit le défilement, les commandes de zoom sont placées à l'écart du panneau et dimensionnées pour le pouce, l'échelle et l'attribution remontent au-dessus de la feuille repliée, et le parcours généré replie automatiquement la feuille.

Navigateur requis : un navigateur à jour, les modules ES dans les workers étant nécessaires.

### Déployer sa propre copie

Dans le dépôt : Settings → Pages → Source → **GitHub Actions**. C'est tout : le workflow `deploiement.yml` téléverse `docs/` tel quel à chaque `git push` sur `main`.

Évitez l'ancienne option « Deploy from a branch » : elle fait tourner Jekyll sur le dossier source, ce qui n'a pas lieu d'être pour un site déjà statique et provoque des erreurs de construction. Si vous y tenez malgré tout, le fichier `docs/.nojekyll` doit impérativement être présent dans le dépôt.

Le dossier `docs/` est autonome : aucun CDN, aucune police externe, aucune clé d'API. Leaflet y est vendorisé, avec sa licence BSD-2-Clause.

## Le script Python

Aucune installation. Il faut Python 3 (déjà présent sur macOS et Linux ; sur Windows, [python.org](https://www.python.org/downloads/)).

```bash
python genere_boucle.py                                  # la carte s'ouvre
python genere_boucle.py --lat 48.85 --lon 2.35 --km 10
python genere_boucle.py --lat 48.85 --lon 2.35 --km 21.1 --niveau strict
```

Sans argument, une carte s'ouvre sur `http://127.0.0.1:8765/` : on y pose son départ à la souris. Le serveur est purement local et s'arrête seul après 15 minutes d'inactivité. Les fichiers produits portent leur date et leur distance (`2026-09-09_18h45_7.0km.gpx`).

`python genere_boucle.py --help` liste toutes les options : arrivée différente du départ, tolérance, part maximale répétée, nombre d'orientations testées, export GeoJSON, rafraîchissement du cache.

### Niveaux d'exigence

| Niveau | Ce qui entre dans le graphe |
| --- | --- |
| `strict` | revêtement dur uniquement |
| `normal` (défaut) | revêtement dur, ou chemin naturel portant une preuve d'entretien |
| `tolerant` | accepte aussi les sentiers sans revêtement ni documentation |

Le niveau `normal` se méfie particulièrement du sous-bois. Un sentier en terre battue, sans nom, sans balisage, sans éclairage et sans état renseigné n'y entre pas : c'est le profil du chemin forestier oublié, qu'un arbre tombé ou un roncier suffit à rendre impraticable sans que la carte en sache rien. Il faut au moins un signe d'entretien — un nom, une appartenance à un itinéraire balisé, un éclairage public, une visibilité ou une qualité de surface renseignées. Sont écartés à tous les niveaux les chemins dont OpenStreetMap signale un encombrement (`obstacle=vegetation`, `log`, `fallen_tree`, `rockfall`…), et au niveau `normal` les chemins naturels notés `smoothness=very_bad`, c'est-à-dire ornières et racines.

Cela reste un filtrage sur les **données**, pas sur le terrain : une carte peut être incomplète ou datée. L'itinéraire est à vérifier avant de le courir.

## Tests

```bash
npm run fixtures    # rejoue le Python d'origine et enregistre ses sorties
npm test            # 87 tests
```

Les fixtures sont produites en exécutant le vrai code Python, pas une réimplémentation. Le portage JavaScript est ensuite comparé à ces sorties : verdicts de praticabilité sur plusieurs dizaines de milliers de combinaisons de tags, géométrie sphérique sur 2000 tirages, classement des boucles candidates, et distances de bout en bout sur un réseau fabriqué — où les deux versions tombent au mètre près.

Le reste de la batterie couvre la contraction du graphe, la réduction 2-cœur, l'A\* et sa pénalité, la validité du GPX produit, le chargement réel de l'interface, et la conformité du site (aucun CDN, aucun traceur, attribution présente, avertissement affiché avec le résultat).

## Statistiques d'usage

Le site compte trois événements : ouverture de la page, génération réussie,
génération en échec. Il transmet le nom de l'événement, une tranche de distance
parmi six et le niveau d'exigence — jamais le point de départ, le tracé,
l'adresse recherchée ni le moindre identifiant. Le compteur n'enregistre que
des agrégats journaliers, sans adresse IP ni ligne par visiteur, ce qui permet
de se passer de bandeau de consentement. Global Privacy Control, Do Not Track
et le lien « Ne pas être compté » sont respectés.

La mesure est **désactivée par défaut** : sans adresse renseignée dans la balise
`point-de-mesure` de `docs/index.html`, le site n'émet aucun appel. Pour
déployer son propre compteur, voir `compteur/README.md`. La version Python ne
comporte aucun comptage.

## Vie privée

Aucun point de départ n'est écrit dans le code. Le site ne collecte rien, ne dépose aucun cookie et n'embarque aucune mesure d'audience ; il retient seulement vos réglages dans le stockage local de votre navigateur, effaçables d'un bouton. Voir les [mentions légales](https://mevennou.github.io/genere-boucle/mentions-legales.html) et la revue de conformité `AUDIT-LEGAL.md`.

## Bon usage des serveurs OpenStreetMap

Le réseau est récupéré auprès de miroirs Overpass publics, tenus par des bénévoles. Le code les interroge un par un et n'en sollicite un second que si le premier tarde, et met les réponses en cache. Merci de ne pas lancer de générations en masse : ces serveurs n'ont pas les moyens d'un service commercial.

## Crédits et licences

- Code : licence MIT, voir `LICENSE`.
- Données routières et fonds de carte : © les contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright), sous [ODbL](https://opendatacommons.org/licenses/odbl/). Les traces GPX produites portent cette attribution dans leurs métadonnées ; conservez-la en cas de republication.
- [Leaflet](https://leafletjs.com/) sous BSD-2-Clause, OpenTopoMap sous CC-BY-SA, tuiles de la Fondation OpenStreetMap et d'OpenStreetMap France.

Projet indépendant, ni affilié à la Fondation OpenStreetMap ni approuvé par elle.

## Auteur

Publié par **mevennou**.
