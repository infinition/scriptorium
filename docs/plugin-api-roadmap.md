# Roadmap : API Plugins Scriptorium

Document de planification. Le chantier se fera après validation de cette direction. Toute section est un objectif, pas une promesse livrée.

## Objectif

Permettre à des modders de créer des plugins pour Scriptorium : widgets dans l'UI, pages supplémentaires dans le panneau de droite (à côté de Idées / Sommaire / Instantanés), accès à l'UI via une API publique curatée, et réaction aux événements de l'app.

## Principes directeurs

- **API publique curatée et versionnée.** On n'expose pas les internals de `app.js`. Les plugins s'appuient sur une façade documentée, pas sur les fonctions internes.
- **Points de contribution.** Boutons, vues, items de menu : les plugins déclarent des contributions, l'app les rend.
- **Trappe de secours limitée.** Un plugin peut manipuler le DOM de son propre widget, pas celui de toute l'app.
- **Confiance locale.** Les plugins sont du code installé par l'utilisateur, exécuté dans le processus de l'app. On assume la confiance, comme Obsidian.
- **Compatibilité.** L'API est versionnée. Chaque évolution majeure de l'app ne doit pas casser les plugins existants.

## Architecture cible

- `window.Scriptorium` : façade publique exposée aux plugins.
- Event bus : hooks de cycle de vie (documents, éditeur, thèmes, workspace, idées, plugins).
- Registre de vues : pages ajoutées au cycle du panneau de droite.
- Registre de contributions : boutons de toolbar/statusbar, items de menu contextuel, items de sidebar.
- Loader de plugins : dossier `.plugins/`, manifest + module, chargé au démarrage.
- Onglet « Plugins » dans les réglages : liste, activer/désactiver, recharger.

## API publique (cible)

### Documents

- `openDoc(id)` : ouvre un document.
- `createDoc(sectionId, title)` : crée un document dans une section.
- `saveDoc()` : force l'enregistrement du document actif.
- `getActiveDoc()` : document actif (id, titre, chemin).
- `listDocs(sectionId)` : documents d'une section.
- `listSections()` : sections du workspace.

### Éditeur

- `insertMarkdown(markdown)` : insère du markdown au curseur.
- `insertBlock(kind, text)` : insère un nouveau bloc (paragraphe, titre, liste…).
- `getSelection()` : sélection courante (texte, offset).
- `getCaret()` : position du curseur.
- `on('editor:selection', fn)` : réagit à la sélection.

### Idées

- `listThemes()` : thèmes d'idées.
- `listIdeas(themeId)` : idées d'un thème.
- `addIdea(themeId, text)` : ajoute une idée.
- `archiveIdea(themeId, text)` : archive une idée.

### Thèmes

- `applyTheme(id)` : applique un thème.
- `getTheme()` : thème actif.
- `on('theme:change', fn)` : réagit au changement de thème.

### UI et contributions

- `registerView(id, { title, render, icon })` : ajoute une page au panneau de droite.
- `registerToolbarButton({ id, icon, label, onClick })` : ajoute un bouton à la topbar.
- `registerStatusbarButton({ id, icon, label, onClick })` : ajoute un bouton à la barre du bas.
- `registerContextMenuItem({ section, label, onClick })` : ajoute un item de menu contextuel.
- `registerSidebarItem({ label, onClick })` : ajoute un item dans la sidebar.

### Réglages et notifications

- `getSetting(key)` / `setSetting(key, value)` : préférences persistées.
- `toast(message)` : notification.
- `showModal(html)` : modal dédiée au plugin.

## Event bus (cible)

- `doc:open`, `doc:save`, `doc:create`, `doc:delete`
- `editor:selection`, `editor:caret`, `editor:block`
- `theme:change`, `font:change`, `bg:change`
- `workspace:change`
- `idea:add`, `idea:archive`, `idea:delete`
- `plugin:load`, `plugin:enable`, `plugin:disable`

## Registre de vues

Le panneau de droite cycle actuellement entre Idées, Sommaire et Instantanés via `setRightPanelView`. Le registre de vues étend ce cycle :

- Un plugin appelle `registerView(id, { title, render })`.
- La vue apparaît dans le cycle avec son titre.
- L'app fournit un conteneur dédié ; `render(container)` y dessine le widget.
- Le plugin garde la main sur ce conteneur uniquement.

## Loader de plugins

- Dossier `<workspace>/.plugins/`.
- Chaque plugin est un sous-dossier : `plugin.json` (manifest) + `main.js`.
- Manifest : `{ "id": "...", "name": "...", "version": "0.1.0", "description": "...", "api": "1" }`.
- `main.js` exporte `activate(ctx)` où `ctx` est la façade `window.Scriptorium`.
- Chargement au démarrage, en activant les plugins marqués actifs.
- Onglet « Plugins » dans les réglages : liste des plugins, activer/désactiver, recharger, voir les erreurs.

## Sécurité

- Les plugins sont du code local de confiance (pas de sandbox en v1).
- Le serveur garde ses gardes de chemin (`safeJoin`, `assertSegment`) : un plugin ne sort pas du workspace via l'API serveur.
- Les plugins n'accèdent pas aux internals serveur, uniquement à l'API publique.
- Piste future : sandbox par iframe ou worker si le besoin apparaît (plugins tiers non vérifiés).

## Phases de réalisation

### Phase 1 : SDK minimal

- `window.Scriptorium` : event bus + API documents + API éditeur (insérer, sélection, caret).
- Registre de vues (pages du panneau de droite).
- Un exemple de plugin de démonstration.

### Phase 2 : contributions et loader

- Registres de contributions (boutons toolbar/statusbar, items de menu, sidebar).
- Loader de plugins (`.plugins/`, manifest, activate).
- Onglet « Plugins » dans les réglages.

### Phase 3 : enrichissement

- Widgets avancés, panneaux dédiés.
- API élargie (idées, thèmes, réglages complets).
- Documentation de référence + exemples de plugins.

## Non-objectifs en v1

- Accès complet aux internals de l'app.
- Sandbox sécurisée (on assume la confiance locale).
- Marché / store de plugins.
- Hot-reload des plugins (recharger manuellement suffit).
