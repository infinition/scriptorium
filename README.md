# Scriptorium

Un éditeur Markdown sans distraction qui lit et écrit des fichiers `.md`
ordinaires sur votre propre disque. Pensé pour l'écriture longue : manifestes,
essais, notes, brouillons.

L'éditeur s'efface devant le texte. Les titres, listes, blocs de code et
formules s'affichent en direct ; la ligne sous votre curseur passe en Markdown
brut pour que vous l'éditiez comme un fichier texte. Rien ne quitte votre
machine.

## Installation

### Version web

```bash
npm install
npm start
```

Ouvrez ensuite `http://localhost:3000`.

### Version bureau (Tauri)

```bash
npm install
npm run tauri:dev
```

La fenêtre native démarre le même serveur Node et affiche l'application. Le
comportement est strictement identique à la version web. Node doit être
disponible dans le `PATH`.

Un pipeline de compilation automatique (GitHub Actions) produit les
installateurs Windows, Linux et macOS à chaque tag de version `v*`. Retrouvez
les binaires sur la page des releases :
<https://github.com/infinition/scriptorium/releases>

## Premier lancement

Au premier lancement, quand aucun dossier de travail n'a encore été configuré,
l'application demande de choisir un dossier existant ou d'en créer un. Ce choix
est enregistré dans `config.json`, à côté de `server.js`. Changez-le plus tard
depuis l'engrenage de la barre latérale, ou en éditant `config.json`.

Un espace de travail vierge est préparé avec un guide bilingue (français et
anglais) qui décrit toutes les fonctions, plus deux thèmes d'idées généraux,
un par langue.

## L'espace de travail

Scriptorium reflète un dossier que vous possédez, structure pour structure :

```
workspace/
  Manifestes/                      <- une section (groupe dans la barre latérale)
    mon-texte.md                   <- un document
  Essais/
    bienvenue.md
  ideas/                           <- la source du nuage d'idées
    général.md                     <- un thème par fichier
```

- Un sous-dossier est une section. Renommez le dossier, la section est renommée.
- Un `.md` à la racine atterrit dans la section implicite « Général ».
- Glissez un `.md` sur une section pour l'importer.
- Les fichiers `ideas/*.md` alimentent le panneau d'idées. Chaque ligne qui
  commence par `- ` est une idée ; `- [x] ...` signifie archivée. Les fichiers
  sont réécrits sur place quand vous cliquez sur une idée, donc les modifier
  depuis un autre éditeur fonctionne aussi.

Les noms de fichiers dérivent du titre (slugifié, ASCII). Changez le titre et
le fichier est renommé à la sauvegarde.

## Fonctions

- **Verrouiller** : cliquez sur « Scriptorium. » en haut à gauche pour bloquer
  les modifications et suppressions. En vigueur côté serveur, pas seulement
  dans l'interface.
- **Panneau de droite** : le bouton en haut du panneau alterne entre les
  idées, le sommaire et les instantanés.
- **Idées** : un nuage de phrases classé par thème. Clic pour archiver, clic
  droit pour insérer dans le texte, survol pour lire.
- **Sommaire** : les titres du document. Cliquez un titre pour sauter à la
  section.
- **Instantanés** : l'historique de révision d'un document. Créez un
  instantané avant une coupe, comparez, restaurez (la version actuelle prend
  sa place dans la liste), supprimez.
- **Fil d'ariane** : cliquez pour remonter en haut du document. Cliquez le nom
  de fichier pour le copier.
- **Mode focus** (`F`), **machine à écrire** (`T`), **focus paragraphe** (`P`),
  **mode lecture** (`R` ou `Tab`), **défilement auto** (`A`).
- **Recherche** (`Ctrl+P`) : plein texte dans les documents et les idées.
- **Rechercher / remplacer** (`Ctrl+F`) : sur le source Markdown.
- **Exporter** : impression / PDF, HTML autonome, Markdown.
- **Coller une image** ou la glisser : elle est enregistrée dans le dossier
  `assets/` du workspace et insérée dans le texte.
- **Sécurité** : les chemins venant du client sont confinés au workspace. Un
  nom de section ou de document ne peut être qu'un segment de chemin.

## Raccourcis clavier

| Raccourci | Action |
|---|---|
| `Ctrl+N` | Nouveau texte |
| `Ctrl+S` | Enregistrer |
| `Ctrl+P` | Recherche |
| `Ctrl+F` | Rechercher / remplacer |
| `Ctrl+G` ou `Ctrl+B` | Gras |
| `Ctrl+I` | Italique |
| `Ctrl+K` puis `C` | Changer le niveau de titre |
| `Ctrl+K` puis `Q` | Citation |
| `Ctrl+K` puis `L` | Liste |
| `Ctrl+K` puis `U` | Souligné |
| `Ctrl+K` puis `D` | Code en ligne |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Annuler / Répéter |
| `T` | Machine à écrire |
| `P` | Focus paragraphe |
| `R` ou `Tab` | Mode lecture |
| `A` | Défilement auto |
| `F` | Mode focus |

## Markdown supporté

CommonMark plus quelques extensions utilisées par Obsidian et GitHub :

- Titres, listes, listes numérotées, cases à cocher (`- [ ]` / `- [x]`)
- Gras, italique, barré, souligné (via `<u>`), code en ligne, surligné (`==text==`)
- Liens, wikilinks (`[[nom]]`), images
- Citations et callouts de style Obsidian (`> [!info] Titre`)
- Tableaux
- Séparateurs
- Blocs de code avec coloration syntaxique (`highlight.js`)
- LaTeX en ligne (`$x^2$`) et centré (`$$ ... $$`) via KaTeX
- Notes de bas de page (`[^1]`)

## Développement

- Node.js + Express côté serveur. Toute l'API est dans `server.js`.
- Pas de framework côté client : `public/{index.html, app.js, style.css}`.
- `highlight.js` et `KaTeX` sont installés en dépendances et servis depuis
  `node_modules` sous `/vendor`. Aucun CDN, tout fonctionne hors ligne.
- Polices : Newsreader (texte), Inter (interface), JetBrains Mono (code).
- La version bureau utilise Tauri (WebView2) comme fenêtre par-dessus le
  serveur Node. `src-tauri/src/lib.rs` lance `node server.js` et ouvre la
  fenêtre sur son URL.
- Le site de présentation est dans `docs/` et publié sur GitHub Pages.

## Licence

ISC. Voir `package.json`.
