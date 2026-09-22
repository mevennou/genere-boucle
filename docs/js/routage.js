// Recherche d'itineraire.
//
// L'A* est appele plusieurs milliers de fois pour une seule generation
// (16 orientations x 4 formes x 10 iterations x autant de troncons que
// d'ancres, puis l'affinage). Reallouer les tableaux de travail a chaque appel
// couterait plus cher que la recherche elle-meme, alors on les alloue une fois
// et on les "efface" en incrementant un numero de passage : une case dont le
// tampon n'est pas celui du passage en cours est consideree comme vide.

import { distanceHaversine } from "./geo.js";

/** Tas binaire sur trois tableaux paralleles (priorite, cout, noeud). */
class Tas {
  constructor(capacite = 1024) {
    this.f = new Float64Array(capacite);
    this.g = new Float64Array(capacite);
    this.n = new Int32Array(capacite);
    this.taille = 0;
  }

  _agrandit() {
    const c = this.f.length * 2;
    const f = new Float64Array(c), g = new Float64Array(c), n = new Int32Array(c);
    f.set(this.f); g.set(this.g); n.set(this.n);
    this.f = f; this.g = g; this.n = n;
  }

  vide() { this.taille = 0; }

  // Ordre lexicographique (f, g, noeud), comme la comparaison de tuples qui
  // departage les ex aequo dans la version Python.
  _avant(i, j) {
    if (this.f[i] !== this.f[j]) return this.f[i] < this.f[j];
    if (this.g[i] !== this.g[j]) return this.g[i] < this.g[j];
    return this.n[i] < this.n[j];
  }

  _echange(i, j) {
    let t = this.f[i]; this.f[i] = this.f[j]; this.f[j] = t;
    t = this.g[i]; this.g[i] = this.g[j]; this.g[j] = t;
    const u = this.n[i]; this.n[i] = this.n[j]; this.n[j] = u;
  }

  pousse(f, g, n) {
    if (this.taille === this.f.length) this._agrandit();
    let i = this.taille++;
    this.f[i] = f; this.g[i] = g; this.n[i] = n;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this._avant(i, p)) break;
      this._echange(i, p); i = p;
    }
  }

  retire() {
    const sommet = [this.f[0], this.g[0], this.n[0]];
    const dernier = --this.taille;
    if (dernier > 0) {
      this.f[0] = this.f[dernier]; this.g[0] = this.g[dernier]; this.n[0] = this.n[dernier];
      let i = 0;
      for (;;) {
        const gauche = 2 * i + 1, droite = gauche + 1;
        let petit = i;
        if (gauche < dernier && this._avant(gauche, petit)) petit = gauche;
        if (droite < dernier && this._avant(droite, petit)) petit = droite;
        if (petit === i) break;
        this._echange(i, petit); i = petit;
      }
    }
    return sommet;
  }
}

export const PENALITE = 12.0;

// Hors agglomeration, le code de la route francais demande au pieton de
// circuler pres du bord gauche de la chaussee, face au trafic. La seule
// occasion ou le graphe peut choisir un bord, c'est quand les deux cotes sont
// cartographies a part : on rencherit alors le cote droit. Une preference,
// pas une interdiction — un detour de plusieurs centaines de metres pour
// changer de trottoir ne vaudrait pas la regle.
export const SURCOUT_COTE_DROIT = 1.35;

export class Routeur {
  /**
   * @param csr adjacence au format CSR
   * @param aretes tableau d'aretes contractees
   * @param lat,lon coordonnees par indice de noeud
   */
  constructor(csr, aretes, lat, lon, nbNoeuds, couloir = null,
              decalage = null, alignement = null) {
    this.csr = csr;
    this.aretes = aretes;
    this.lat = lat; this.lon = lon;
    this.nbNoeuds = nbNoeuds;

    this.poids = Float64Array.from(aretes, (a) => a.poids);
    this.longueurs = Float64Array.from(aretes, (a) => a.longueur);

    this.cout = new Float64Array(nbNoeuds);
    this.tampon = new Int32Array(nbNoeuds);
    this.vu = new Int32Array(nbNoeuds);
    this.parentNoeud = new Int32Array(nbNoeuds);
    this.parentArete = new Int32Array(nbNoeuds);
    this.heuristique = new Float64Array(nbNoeuds);
    this.tamponH = new Int32Array(nbNoeuds);
    this.passage = 0;

    // Une rue et son trottoir cartographie a part sont deux aretes, mais une
    // seule voie physique. La penalite raisonne par couloir, sinon revenir par
    // le trottoir ne couterait rien apres etre alle par la rue.
    this.couloir = couloir || Int32Array.from({ length: aretes.length }, (_, i) => i);
    this.tamponPenalite = new Int32Array(aretes.length);
    this.passagePenalite = 0;

    // Cote de la chaussee, pour les seules voies jumelees. Ailleurs, le
    // decalage vaut zero et rien ne change.
    this.decalage = decalage || new Float64Array(aretes.length);
    this.alignement = alignement || new Int8Array(aretes.length).fill(1);
    this.debut = Int32Array.from(aretes, (a) => a.u);

    this.tas = new Tas();
  }

  /** Ouvre une nouvelle serie de penalites : les precedentes sont oubliees. */
  nouvellesPenalites() { this.passagePenalite += 1; }

  penalise(indexArete) {
    this.tamponPenalite[this.couloir[indexArete]] = this.passagePenalite;
  }

  estPenalisee(indexArete) {
    return this.tamponPenalite[this.couloir[indexArete]] === this.passagePenalite;
  }

  _h(noeud, latBut, lonBut) {
    if (this.tamponH[noeud] === this.passage) return this.heuristique[noeud];
    const d = distanceHaversine(this.lat[noeud], this.lon[noeud], latBut, lonBut);
    this.heuristique[noeud] = d;
    this.tamponH[noeud] = this.passage;
    return d;
  }

  /**
   * A* de source vers but. Les aretes de la serie de penalites en cours sont
   * payees PENALITE fois plus cher : c'est ce qui interdit les allers-retours.
   * Renvoie null si le but est inatteignable, sinon [cout, trajet] ou trajet
   * est une liste de [indexArete, noeudDepuis].
   */
  plusCourtChemin(source, but) {
    if (source === but) return [0.0, []];
    const { debut, voisin, arete } = this.csr;
    const latBut = this.lat[but], lonBut = this.lon[but];
    const passage = ++this.passage;
    const tas = this.tas;
    tas.vide();

    this.cout[source] = 0; this.tampon[source] = passage;
    tas.pousse(this._h(source, latBut, lonBut), 0, source);

    let atteint = false;
    while (tas.taille) {
      const [, cout, noeud] = tas.retire();
      if (this.vu[noeud] === passage) continue;
      this.vu[noeud] = passage;
      if (noeud === but) { atteint = true; break; }

      for (let k = debut[noeud]; k < debut[noeud + 1]; k++) {
        const v = voisin[k];
        if (this.vu[v] === passage) continue;
        const index = arete[k];
        let poids = this.poids[index];
        if (this.tamponPenalite[this.couloir[index]] === this.passagePenalite) poids *= PENALITE;
        // Courir a gauche : le sens de parcours decide de quel bord il s'agit.
        const ecart = this.decalage[index];
        if (ecart !== 0) {
          const sens = (noeud === this.debut[index] ? 1 : -1) * this.alignement[index];
          if (ecart * sens < 0) poids *= SURCOUT_COTE_DROIT;
        }
        const nouveau = cout + poids;
        if (this.tampon[v] !== passage || nouveau < this.cout[v]) {
          this.cout[v] = nouveau;
          this.tampon[v] = passage;
          this.parentNoeud[v] = noeud;
          this.parentArete[v] = index;
          tas.pousse(nouveau + this._h(v, latBut, lonBut), nouveau, v);
        }
      }
    }

    if (!atteint) return null;
    return [this.cout[but], this._remonte(source, but, passage)];
  }

  _remonte(source, but, passage) {
    const trajet = [];
    let courant = but;
    let garde = 0;
    while (courant !== source) {
      if (++garde > 1000000) break;
      trajet.push([this.parentArete[courant], this.parentNoeud[courant]]);
      courant = this.parentNoeud[courant];
    }
    trajet.reverse();
    return trajet;
  }

  /**
   * Chemin le plus court du depart vers le premier noeud du reseau maille.
   * On explore le reseau plutot que de viser le plus proche a vol d'oiseau :
   * le voisin d'en face peut n'etre accessible qu'en contournant un pate de
   * maisons. Dijkstra sur l'adjacence complete, pas sur le coeur.
   */
  rejointCoeur(adjacenceComplete, source, estCoeur) {
    if (estCoeur(source)) return [source, []];
    const passage = ++this.passage;
    const tas = this.tas;
    tas.vide();
    this.cout[source] = 0; this.tampon[source] = passage;
    tas.pousse(0, 0, source);

    while (tas.taille) {
      const [, cout, noeud] = tas.retire();
      if (this.vu[noeud] === passage) continue;
      this.vu[noeud] = passage;
      if (estCoeur(noeud)) return [noeud, this._remonte(source, noeud, passage)];
      for (const [v, index] of (adjacenceComplete[noeud] || [])) {
        const nouveau = cout + this.poids[index];
        if (this.tampon[v] !== passage || nouveau < this.cout[v]) {
          this.cout[v] = nouveau;
          this.tampon[v] = passage;
          this.parentNoeud[v] = noeud;
          this.parentArete[v] = index;
          tas.pousse(nouveau, nouveau, v);
        }
      }
    }
    return [null, null];
  }

  longueurTrajet(trajet) {
    let total = 0;
    for (const [index] of trajet) total += this.longueurs[index];
    return total;
  }
}
