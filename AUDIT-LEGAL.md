# Revue de conformité

Passage en revue du projet avant mise en ligne publique, du point de vue du
droit français et européen et des conditions d'usage des services tiers
utilisés. Ce document n'est pas un conseil juridique : c'est une revue
structurée, à faire relire par un professionnel si le projet prend de l'ampleur
ou devient commercial.

Trois niveaux : **bloquant** avant mise en ligne, **à corriger** dans le code,
**à surveiller** dans le temps.

---

## 1. Identité de l'éditeur — conforme avec le pseudonyme

**Constat.** L'article 6 III de la LCEN impose des mentions d'identification.
Mais son alinéa 2 réserve un régime aux éditeurs **non professionnels** : ils
peuvent ne pas publier leur identité, à condition d'avoir communiqué leurs
éléments d'identification à l'hébergeur. Publier sous « mevennou » est donc
régulier, à trois conditions cumulatives.

**Ce qui doit rester vrai.**

- Le site reste non professionnel : pas de publicité, pas d'affiliation, pas de
  don, pas de vente, pas de service payant. Le jour où une seule de ces lignes
  bouge, l'identité complète devient obligatoire.
- GitHub détient bien ton identité : compte nominatif, moyen de paiement ou
  email vérifié. C'est le cas par construction.
- Les coordonnées de l'hébergeur sont publiées. C'est fait dans
  `mentions-legales.html`.

**Action.** Aucune, hors le remplissage du contact.

---

## 2. Bloquant : la couche satellite Esri doit disparaître

**Constat.** Le script appelle
`server.arcgisonline.com/ArcGIS/rest/services/World_Imagery`. Ce point d'accès
n'est pas un service ouvert : l'imagerie World Imagery est un produit sous
licence, dont les conditions d'Esri réservent l'usage aux détenteurs d'un compte
ou d'un abonnement, avec attribution contractuelle. L'usage était tolérable
dans un outil local lancé par toi seul. Sur un site public, il devient une
diffusion à des tiers d'un flux sous licence, sans titre pour le faire. Cerise
sur le gâteau, c'est aussi le seul serveur états-unien commercial de la liste,
donc le plus exposé côté transferts hors UE.

**Action.** Retirer la couche « Satellite » du sélecteur de fonds de carte pour
la version web. Elle peut rester dans la version locale du script, qui n'est pas
une diffusion publique. Si tu tiens à une vue aérienne sur le site, l'orthophoto
de l'IGN est accessible librement pour la France et se branche en une ligne dans
Leaflet.

---

## 3. Bloquant : Leaflet doit être servi depuis ton dépôt

**Constat.** Le script charge Leaflet depuis `cdnjs.cloudflare.com`. Chaque
visiteur déclenche donc une requête vers un CDN américain, qui reçoit son
adresse IP, sans que rien ne l'impose. C'est un tiers de plus à déclarer, un
transfert hors UE de plus à justifier, et une dépendance réseau de plus à la
première visite.

**Action.** Vendoriser Leaflet : déposer `leaflet.js` et `leaflet.css` dans le
dépôt, les servir depuis la même origine. Trois bénéfices d'un coup, la
conformité, la vitesse, et un tiers en moins dans les mentions légales. La
licence BSD-2-Clause l'autorise expressément, à condition de conserver l'en-tête
de copyright dans les fichiers, ce qui est le cas par défaut dans les fichiers
distribués. Même raisonnement pour toute police : on reste sur les polices
système, donc aucun appel à Google Fonts.

---

## 4. À corriger : la recherche d'adresse ne doit pas être un autocomplete

**Constat.** Le script interroge Nominatim à chaque frappe, avec un délai de
450 ms. La politique d'usage de Nominatim demande au maximum une requête par
seconde et **interdit explicitement les usages de type autocomplete**, qui sont
la première cause de blocage d'IP et de domaines. Sur un site public, c'est le
risque le plus concret du lot : ce n'est pas un procès, c'est ton site qui cesse
de fonctionner du jour au lendemain.

**Action.** Déclencher la recherche sur validation, touche Entrée ou bouton, et
jamais à la frappe. Afficher l'attribution requise avec les résultats. Prévoir
un message clair quand le service refuse la requête.

---

## 5. À surveiller : politiques d'usage des serveurs de tuiles et d'Overpass

**Constat.** `tile.openstreetmap.org`, les tuiles d'OpenStreetMap France,
OpenTopoMap et les miroirs Overpass sont des services bénévoles régis par des
politiques d'usage, pas par des contrats. Elles tolèrent un trafic modéré et
excluent les usages massifs ou automatisés.

**Points favorables à ton architecture.** Le calcul se fait chez le visiteur :
chaque requête part de son IP, la charge reste diffuse, et aucun serveur ne voit
un pic venant d'une seule machine. C'est précisément ce que ces politiques
cherchent à éviter, et c'est l'argument à mettre en avant si on te pose la
question.

**Actions.**

- Ne jamais masquer le contrôle d'attribution de Leaflet, en bas à droite de la
  carte. C'est l'exigence d'attribution de l'ODbL, et elle est non
  négociable.
- Garder la mise en cache locale des réponses Overpass : une même zone n'est
  téléchargée qu'une fois par visiteur.
- Conserver l'interrogation décalée des miroirs, qui évite de tripler la charge.
- Surveiller la fréquentation. Si le site décolle, prévoir un fournisseur de
  tuiles avec clé et un point d'accès Overpass dédié.

---

## 6. Conforme : pas de bannière de consentement nécessaire

**Constat.** L'article 82 de la loi Informatique et Libertés soumet au
consentement toute écriture ou lecture d'informations sur le terminal de
l'utilisateur, sauf si elle est strictement nécessaire à la fourniture d'un
service expressément demandé. Le site n'écrit que des réglages définis par
l'utilisateur lui-même, pour lui restituer son propre paramétrage. La CNIL range
cette catégorie parmi les exemptions.

**Conditions à tenir.**

- Aucune mesure d'audience, même dite anonyme, sans réexamen de ce point.
- Aucun contenu tiers embarqué qui dépose un cookie.
- Le stockage reste limité aux réglages, ne contient aucun identifiant unique et
  ne sert à aucun recoupement.

**Action.** Ajouter un bouton « effacer mes réglages » dans le panneau.
Non obligatoire, mais c'est la preuve concrète que le stockage est bien une
commodité et non un traçage, et c'est trente secondes de code.

---

## 7. Conforme : sécurité juridique du contenu produit

**Constat.** Les traces GPX sont une œuvre dérivée de la base OpenStreetMap,
sous ODbL. L'ODbL distingue la base elle-même, soumise au partage à
l'identique, et l'œuvre produite à partir d'elle, pour laquelle seule
l'attribution est exigée. Une trace GPX est une œuvre produite : tu dois
l'attribuer, tu n'as pas à la placer sous ODbL.

**Action.** Faite. Le bloc `<copyright>` a été ajouté dans les métadonnées GPX,
l'attribution voyage donc avec le fichier, y compris quand il est importé dans
une montre ou réexporté ailleurs.

---

## 8. Responsabilité : le point le plus sérieux du dossier

**Constat.** Une application qui envoie des gens courir sur des itinéraires
calculés automatiquement crée un risque physique réel. Le disclaimer MIT couvre
le logiciel, pas le service rendu au public. Et en droit français, une clause
limitative de responsabilité ne joue ni en cas de faute lourde, ni pour un
dommage à l'intégrité physique.

**Ce que ça implique concrètement.** L'avertissement ne doit pas être enterré
dans une page que personne n'ouvre. Il doit être visible au moment où il compte,
c'est-à-dire avec le résultat.

**Actions.**

- Afficher un rappel court à côté du parcours généré, une phrase, pas un pavé :
  vérifier le terrain, respecter le code de la route, la carte peut se tromper.
- Ne jamais présenter l'outil comme un dispositif de navigation ou de sécurité.
  Le vocabulaire compte : « suggestion de parcours », pas « itinéraire
  sécurisé ». À ce titre, la formulation actuelle du README, qui parle de
  chemins « dont OpenStreetMap prouve qu'ils sont praticables », est trop
  affirmative pour un public large. La garantie est structurelle sur les
  **données**, pas sur le terrain. À reformuler avant la mise en ligne.
- Garder la mention de non-garantie dans les mentions légales, elle reste utile
  même si elle n'est pas absolue.

---

## 9. Divers vérifiés, sans action

- **Marque.** Ne pas nommer le site avec « OpenStreetMap » ni reprendre son
  logo : la marque appartient à la Fondation. « Générateur de boucles » ne pose
  aucun problème. La mention d'indépendance est dans les mentions légales.
- **Accessibilité.** Le RGAA vise le secteur public et les grandes entreprises.
  Aucune obligation ici, aucune déclaration à publier.
- **Registre des traitements RGPD.** Sans collecte, sans base de données et sans
  destinataire côté éditeur, il n'y a pas de traitement dont tu sois
  responsable. Rien à tenir.
- **Mineurs.** Pas de collecte, pas de compte, pas de contenu sensible : rien de
  spécifique.
- **Droit de la consommation.** Service gratuit sans contrepartie : ni contrat à
  distance, ni obligation d'information précontractuelle.

---

## Récapitulatif des actions

| # | Action | Où |
| --- | --- | --- |
| 1 | Remplir contact et adresse du site | `mentions-legales.html` |
| 2 | Retirer la couche satellite Esri | version web |
| 3 | Servir Leaflet depuis le dépôt | version web |
| 4 | Recherche d'adresse sur validation uniquement | version web |
| 5 | Ne pas masquer l'attribution de la carte | version web |
| 6 | Bouton d'effacement des réglages | version web |
| 7 | Avertissement court avec le résultat | version web |
| 8 | Reformuler la promesse de praticabilité | `README.md` |
| 9 | Lien vers les mentions légales en pied de page | version web |

Les points 2 à 7 et 9 sont intégrés directement dans la version web en cours de
construction. Les points 1 et 8 te reviennent.
