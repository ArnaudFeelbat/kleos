# Nouveautés de Kleos

## Version 0.2.0 — 18 novembre 2026

### Plusieurs serveurs dans une seule fenêtre

- **Un onglet par serveur.** Kleos s'ouvre désormais dans une seule fenêtre. Chaque serveur
  auquel vous vous connectez apparaît dans son propre onglet, en haut de la fenêtre, avec sa
  pastille de couleur et son nom.
- **Pas de doublon.** Si un serveur est déjà ouvert, vous connecter à nouveau vous ramène
  simplement à son onglet.
- **Rien ne se perd en changeant d'onglet.** Chaque serveur garde ses requêtes, ses
  modifications en attente et son diagramme pendant que vous travaillez ailleurs.
- **Fermer proprement.** Fermer un onglet ferme la connexion à ce serveur ; fermer la fenêtre
  ferme toutes les connexions.
- **Lecture seule bien visible.** Les connexions en lecture seule affichent un cadenas dans
  leur onglet.
- **Nouveaux raccourcis :**
  - ⌘T : revenir à la liste des connexions pour en ouvrir une autre
  - ⌘W : fermer l'onglet en cours
  - ⌘1 à ⌘9 : aller directement à un onglet (⌘9 = le dernier)
  - ⌘⇧] et ⌘⇧[ : onglet suivant / précédent

### Un nouveau design, plus soigné

- **Intégré à macOS.** La barre latérale et la barre d'onglets sont translucides et laissent
  transparaître votre bureau, comme dans les apps d'Apple.
- **Une couleur d'accent.** Le bleu de l'icône Kleos marque désormais la sélection, les
  boutons principaux et l'onglet actif.
- **Plus de profondeur.** Cartes en relief, ombres plus douces, transitions discrètes et
  barres de défilement fines.
- **Mode sombre retravaillé**, écran par écran.
- **Tous les écrans revus :** connexions, diagramme du schéma, données, éditeur de requêtes,
  graphiques, plan d'exécution et monitoring.
- **Monitoring :** une mini-courbe des transactions par seconde apparaît directement dans sa
  tuile.
- **États plus clairs :** messages quand une liste est vide, chargements animés et
  notifications harmonisées.

### Améliorations

- À l'ouverture d'une base, Kleos affiche directement le schéma qui contient vos tables,
  au lieu d'un schéma « public » vide.
- Boutons et champs plus compacts, au format habituel des applications Mac.

### Corrections

- Dans l'éditeur de requêtes, le soulignement de l'erreur disparaissait après un changement
  d'onglet. Il reste maintenant affiché tant que la requête n'est pas relancée.

### Bon à savoir

- La couleur choisie pour une connexion teinte désormais son onglet et sa barre d'outils,
  plutôt que toute la fenêtre.

---

## Version 0.1.0 — 18 novembre 2026

Première version de Kleos :

- connexions enregistrées, avec les mots de passe gardés dans le trousseau macOS ;
- diagramme du schéma, avec la disposition des tables mémorisée ;
- consultation des données avec tri, filtres et modifications vérifiées avant d'être
  appliquées ;
- éditeur SQL avec autocomplétion, graphiques et plan d'exécution ;
- monitoring en direct : sessions, verrous, activité et requêtes lentes.
