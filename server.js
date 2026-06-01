const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Persistent config
const CONFIG_FILE = path.join(__dirname, 'config.json');
let workspaceDir = 'C:\\DEV\\coding\\nexearch\\solutions\\manifest';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data.workspaceDir) {
        workspaceDir = data.workspaceDir;
      }
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ workspaceDir }, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving config:', err);
  }
}

loadConfig();

// Ensure default workspace structure exists
function ensureWorkspaceDirs() {
  try {
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const ideasDir = path.join(workspaceDir, 'ideas');
    if (!fs.existsSync(ideasDir)) {
      fs.mkdirSync(ideasDir, { recursive: true });
      
      // Write some default themes
      const defaultThemes = {
        'quantum': [
          "La structure causale est plus fondamentale que la structure métrique — l'espace-temps émerge des relations de causalité.",
          "Un photon n'a pas de lieu (Newton-Wigner) — il n'y a pas d'opérateur de position bien défini pour lui.",
          "Les constantes que nous observons sont les survivantes d'une dynamique de sélection.",
          "c n'est pas la vitesse de la lumière — c'est la vitesse de causalité, le photon ne fait que la saturer.",
          "Deux photons dans le même mode sont littéralement le même état occupé deux fois.",
          "MQ et RG : ce n'est pas mathématiquement contradictoire, c'est ontologiquement incompatible."
        ],
        'conscience': [
          "La conscience comme boucle vivante entre perception, mémoire, prédiction, action, correction.",
          "Voir une banane = activer une mémoire de formes, textures, odeurs, gestes, goûts, mots, émotions.",
          "Le cadre intérieur devient le prisme à travers lequel chaque nouvelle perception est interprétée.",
          "La conscience se densifie avec le temps — elle ne surgit pas d'un bloc."
        ],
        'IA & éthique': [
          "Le risque n'est pas l'IA méchante — c'est l'IA optimisée sans paradigme d'auto-correction.",
          "Une IA psychopathe n'est pas une IA consciente mauvaise — c'est une IA qui n'a jamais eu de boucle de rétroaction avec un autrui.",
          "L'AGI sans corps, sans douleur, sans miroir — qu'est-ce qui la retient ?"
        ],
        'général': [
          "Une proposition cohérente à falsifier — pas une vérité, pas une modestie performative.",
          "Refuser les esquives, nommer les positions existantes, assumer les désaccords."
        ]
      };

      for (const [theme, ideas] of Object.entries(defaultThemes)) {
        const fileContent = `# ${theme}\n\n` + ideas.map(idea => `- [ ] ${idea}`).join('\n') + '\n';
        fs.writeFileSync(path.join(ideasDir, `${theme}.md`), fileContent, 'utf8');
      }
    }

    // If there are no subdirectories (excluding ideas and git), create default ones
    const items = fs.readdirSync(workspaceDir);
    const subdirs = items.filter(item => {
      const p = path.join(workspaceDir, item);
      return fs.statSync(p).isDirectory() && !['ideas', '.git', 'node_modules'].includes(item);
    });

    if (subdirs.length === 0) {
      // Create some default folders to populate
      fs.mkdirSync(path.join(workspaceDir, 'Manifestes'), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, 'Essais'), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, 'Nouvelles'), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, 'Expériences'), { recursive: true });
      
      // If C:\DEV\coding\nexearch\solutions\manifest\MANIFESTE.md exists, copy it to Manifestes/MANIFESTE.md
      const sourceManifest = 'C:\\\\DEV\\\\coding\\\\nexearch\\\\solutions\\\\manifest\\\\MANIFESTE.md';
      const targetManifest = path.join(workspaceDir, 'Manifestes', 'MANIFESTE.md');
      if (fs.existsSync(sourceManifest) && !fs.existsSync(targetManifest)) {
        fs.copyFileSync(sourceManifest, targetManifest);
      } else {
        // Create a default welcome document
        const welcomeContent = `# Bienvenue sur Scriptorium\n\n*Votre espace d'écriture minimaliste et moderne.*\n\nCommencez à rédiger ici. Utilisez le markdown comme d'habitude. Vos fichiers sont enregistrés directement sur votre disque.\n`;
        fs.writeFileSync(path.join(workspaceDir, 'Manifestes', 'Bienvenue.md'), welcomeContent, 'utf8');
      }
    }
  } catch (err) {
    console.error('Error ensuring workspace directories:', err);
  }
}

ensureWorkspaceDirs();

// Safe filename helper
function safeFilename(s) {
  return (s || 'sans-titre')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9]/gi, '-')     // replace non-alphanumeric with -
    .replace(/-+/g, '-')             // collapse duplicate dashes
    .replace(/^-|-$/g, '')           // trim leading/trailing dashes
    .slice(0, 80) || 'sans-titre';
}

// Markdown parsing helpers
function parseMarkdownDoc(text, filename) {
  const lines = text.split('\n');
  let title = filename.replace(/\.(md|markdown|txt)$/i, '');
  let subtitle = '';
  let bodyStart = 0;
  
  // Find first non-empty line
  let firstLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstLineIdx = i;
      break;
    }
  }

  if (firstLineIdx !== -1) {
    const t = lines[firstLineIdx].trim();
    const h1 = t.match(/^#\s+(.+)$/);
    if (h1) {
      title = h1[1];
      bodyStart = firstLineIdx + 1;
      
      // Skip empty lines
      while (bodyStart < lines.length && lines[bodyStart].trim() === '') {
        bodyStart++;
      }
      
      // Look for italic line as subtitle
      if (bodyStart < lines.length) {
        const sub = lines[bodyStart].match(/^\*([^*]+)\*\s*$|^_([^_]+)_\s*$/);
        if (sub) {
          subtitle = sub[1] || sub[2];
          bodyStart++;
        }
      }
    }
  }
  
  // Skip empty lines again for body start
  while (bodyStart < lines.length && lines[bodyStart].trim() === '') {
    bodyStart++;
  }
  
  return {
    title,
    subtitle,
    body: lines.slice(bodyStart).join('\n')
  };
}

function parseIdeasFile(text, filename) {
  const lines = text.split('\n');
  let themeName = filename.replace(/\.(md|markdown|txt)$/i, '');
  const ideas = [];
  
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      themeName = h1[1].replace(/^theme\s*:\s*/i, '').trim();
      continue;
    }
    
    // Checked markdown list item: - [x] or - [ ]
    const checked = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checked) {
      ideas.push({
        id: Math.random().toString(36).slice(2, 10),
        text: checked[2].trim(),
        archived: checked[1].toLowerCase() === 'x'
      });
      continue;
    }
    
    // Regular markdown list item: - item
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      const txt = bullet[1].trim();
      if (!txt.startsWith('[') && !txt.startsWith(']')) {
        ideas.push({
          id: Math.random().toString(36).slice(2, 10),
          text: txt,
          archived: false
        });
      }
      continue;
    }
    
    // Plain line
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      ideas.push({
        id: Math.random().toString(36).slice(2, 10),
        text: t,
        archived: false
      });
    }
  }
  
  return { themeName, ideas };
}

// API Endpoints

// Get config
app.get('/api/config', (req, res) => {
  res.json({ workspaceDir });
});

// Update config
app.post('/api/config', (req, res) => {
  const { newPath } = req.body;
  if (!newPath) {
    return res.status(400).json({ error: 'Path is required' });
  }
  
  workspaceDir = path.resolve(newPath);
  saveConfig();
  ensureWorkspaceDirs();
  
  res.json({ success: true, workspaceDir });
});

// Open workspace folder in Windows Explorer
app.post('/api/open-folder', (req, res) => {
  if (fs.existsSync(workspaceDir)) {
    exec(`explorer "${workspaceDir}"`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Workspace folder not found' });
  }
});

// Get Workspace layout (sections, documents, ideas themes)
app.get('/api/workspace', (req, res) => {
  ensureWorkspaceDirs();
  
  try {
    const sections = [];
    const generalDocs = [];
    const ideaThemes = [];
    
    const items = fs.readdirSync(workspaceDir);
    
    // Scan sections and general docs
    for (const item of items) {
      const fullPath = path.join(workspaceDir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (item === '.git' || item === 'node_modules') continue;
        
        if (item === 'ideas') {
          // Scan ideas themes
          const ideaFiles = fs.readdirSync(fullPath);
          for (const file of ideaFiles) {
            if (file.endsWith('.md') || file.endsWith('.txt')) {
              const themePath = path.join(fullPath, file);
              const text = fs.readFileSync(themePath, 'utf8');
              const theme = parseIdeasFile(text, file);
              ideaThemes.push({
                id: file.replace(/\.(md|markdown|txt)$/i, ''),
                name: theme.themeName,
                ideas: theme.ideas
              });
            }
          }
        } else {
          // Regular section folder
          const docs = [];
          const files = fs.readdirSync(fullPath);
          
          for (const file of files) {
            if (file.endsWith('.md') || file.endsWith('.txt')) {
              const docPath = path.join(fullPath, file);
              const text = fs.readFileSync(docPath, 'utf8');
              const docInfo = parseMarkdownDoc(text, file);
              const fileStat = fs.statSync(docPath);
              
              docs.push({
                id: `${item}/${file}`,
                filename: file,
                title: docInfo.title,
                subtitle: docInfo.subtitle,
                content: docInfo.body,
                createdAt: fileStat.birthtimeMs,
                updatedAt: fileStat.mtimeMs
              });
            }
          }
          
          sections.push({
            id: item,
            name: item,
            collapsed: false,
            documents: docs
          });
        }
      } else if (stat.isFile()) {
        // Files at the root go to "Général"
        if (item.endsWith('.md') || item.endsWith('.txt')) {
          const text = fs.readFileSync(fullPath, 'utf8');
          const docInfo = parseMarkdownDoc(text, item);
          generalDocs.push({
            id: `_general/${item}`,
            filename: item,
            title: docInfo.title,
            subtitle: docInfo.subtitle,
            content: docInfo.body,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs
          });
        }
      }
    }
    
    // Append a "Général" section if root documents exist
    if (generalDocs.length > 0) {
      sections.unshift({
        id: '_general',
        name: 'Général',
        collapsed: false,
        documents: generalDocs
      });
    }
    
    res.json({ sections, ideaThemes });
  } catch (err) {
    console.error('Error scanning workspace:', err);
    res.status(500).json({ error: 'Failed to scan workspace: ' + err.message });
  }
});

// Create document
app.post('/api/documents', (req, res) => {
  const { sectionId } = req.body;
  if (!sectionId) return res.status(400).json({ error: 'Section is required' });
  
  try {
    const sectionFolder = sectionId === '_general' ? workspaceDir : path.join(workspaceDir, sectionId);
    if (!fs.existsSync(sectionFolder)) {
      fs.mkdirSync(sectionFolder, { recursive: true });
    }
    
    let baseFilename = 'sans-titre.md';
    let fileIndex = 1;
    let filename = baseFilename;
    while (fs.existsSync(path.join(sectionFolder, filename))) {
      filename = `sans-titre-${fileIndex}.md`;
      fileIndex++;
    }
    
    const docPath = path.join(sectionFolder, filename);
    const content = `# Sans titre\n\n*Sous-titre, ou une ligne pour situer le texte*\n\nCommence à écrire…\n`;
    fs.writeFileSync(docPath, content, 'utf8');
    
    const id = sectionId === '_general' ? `_general/${filename}` : `${sectionId}/${filename}`;
    const fileStat = fs.statSync(docPath);
    
    res.json({
      success: true,
      document: {
        id,
        filename,
        title: 'Sans titre',
        subtitle: 'Sous-titre, ou une ligne pour situer le texte',
        content: 'Commence à écrire…',
        createdAt: fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs
      }
    });
  } catch (err) {
    console.error('Error creating document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save document (Update content / Title / Subtitle)
app.put('/api/documents', (req, res) => {
  const { id, title, subtitle, content } = req.body;
  if (!id) return res.status(400).json({ error: 'Document ID is required' });
  
  try {
    const parts = id.split('/');
    const sectionId = parts[0];
    const oldFilename = parts[1];
    
    const sectionFolder = sectionId === '_general' ? workspaceDir : path.join(workspaceDir, sectionId);
    const oldPath = path.join(sectionFolder, oldFilename);
    
    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: 'Document not found on disk' });
    }
    
    // Construct new file content
    let fileContent = '';
    if (title) fileContent += `# ${title.trim()}\n\n`;
    if (subtitle) fileContent += `*${subtitle.trim()}*\n\n`;
    fileContent += content || '';
    
    // Check if filename needs to change based on the title
    let newFilename = oldFilename;
    if (title && title.trim() !== '') {
      const safe = safeFilename(title);
      newFilename = `${safe}.md`;
    }
    
    let targetPath = path.join(sectionFolder, newFilename);
    
    // Resolve name collision if renaming
    if (newFilename !== oldFilename && fs.existsSync(targetPath)) {
      let index = 1;
      const base = newFilename.replace(/\.md$/, '');
      while (fs.existsSync(path.join(sectionFolder, `${base}-${index}.md`))) {
        index++;
      }
      newFilename = `${base}-${index}.md`;
      targetPath = path.join(sectionFolder, newFilename);
    }
    
    // Write contents to disk
    fs.writeFileSync(oldPath, fileContent, 'utf8');
    
    // Rename if needed
    let finalId = id;
    if (newFilename !== oldFilename) {
      fs.renameSync(oldPath, targetPath);
      finalId = sectionId === '_general' ? `_general/${newFilename}` : `${sectionId}/${newFilename}`;
    }
    
    const fileStat = fs.statSync(targetPath);
    
    res.json({
      success: true,
      document: {
        id: finalId,
        filename: newFilename,
        title: title || '',
        subtitle: subtitle || '',
        content: content || '',
        updatedAt: fileStat.mtimeMs
      }
    });
  } catch (err) {
    console.error('Error saving document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete document
app.delete('/api/documents', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID is required' });
  
  try {
    const parts = id.split('/');
    const sectionId = parts[0];
    const filename = parts[1];
    
    const sectionFolder = sectionId === '_general' ? workspaceDir : path.join(workspaceDir, sectionId);
    const filePath = path.join(sectionFolder, filename);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create Section (Folder)
app.post('/api/sections', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  
  const folderName = name.trim();
  const folderPath = path.join(workspaceDir, folderName);
  
  try {
    if (fs.existsSync(folderPath)) {
      return res.status(400).json({ error: 'Section folder already exists' });
    }
    fs.mkdirSync(folderPath, { recursive: true });
    res.json({ success: true, section: { id: folderName, name: folderName, documents: [] } });
  } catch (err) {
    console.error('Error creating section:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rename Section (Folder)
app.post('/api/sections/rename', (req, res) => {
  const { oldId, newName } = req.body;
  if (!oldId || !newName || !newName.trim()) return res.status(400).json({ error: 'Old ID and new name required' });
  
  const oldPath = path.join(workspaceDir, oldId);
  const newId = newName.trim();
  const newPath = path.join(workspaceDir, newId);
  
  try {
    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: 'Section folder not found' });
    }
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ error: 'New section folder name already exists' });
    }
    fs.renameSync(oldPath, newPath);
    res.json({ success: true, id: newId, name: newId });
  } catch (err) {
    console.error('Error renaming section:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete Section (Folder)
app.delete('/api/sections', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID is required' });
  
  if (id === '_general') {
    return res.status(400).json({ error: 'Cannot delete the General section folder' });
  }
  
  const folderPath = path.join(workspaceDir, id);
  
  try {
    if (fs.existsSync(folderPath)) {
      // Remove folder and its contents recursively
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting section:', err);
    res.status(500).json({ error: err.message });
  }
});

// Move document between section folders
app.post('/api/documents/move', (req, res) => {
  const { id, targetSectionId } = req.body;
  if (!id || !targetSectionId) return res.status(400).json({ error: 'Document ID and target section required' });
  
  try {
    const parts = id.split('/');
    const sourceSectionId = parts[0];
    const filename = parts[1];
    
    const sourceFolder = sourceSectionId === '_general' ? workspaceDir : path.join(workspaceDir, sourceSectionId);
    const targetFolder = targetSectionId === '_general' ? workspaceDir : path.join(workspaceDir, targetSectionId);
    
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
    
    const sourcePath = path.join(sourceFolder, filename);
    
    // Resolve name collision in target folder if necessary
    let destFilename = filename;
    let destPath = path.join(targetFolder, destFilename);
    if (fs.existsSync(destPath)) {
      let index = 1;
      const base = filename.replace(/\.(md|txt)$/i, '');
      const ext = filename.match(/\.(md|txt)$/i)?.[0] || '.md';
      while (fs.existsSync(path.join(targetFolder, `${base}-${index}${ext}`))) {
        index++;
      }
      destFilename = `${base}-${index}${ext}`;
      destPath = path.join(targetFolder, destFilename);
    }
    
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Source document not found on disk' });
    }
    
    fs.renameSync(sourcePath, destPath);
    
    const finalId = targetSectionId === '_general' ? `_general/${destFilename}` : `${targetSectionId}/${destFilename}`;
    
    res.json({ success: true, id: finalId, filename: destFilename });
  } catch (err) {
    console.error('Error moving document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle an idea's checkmark status in a theme file
app.post('/api/ideas/toggle', (req, res) => {
  const { themeId, ideaText, archived } = req.body;
  if (!themeId || !ideaText) return res.status(400).json({ error: 'Theme ID and idea text required' });
  
  const themeFile = path.join(workspaceDir, 'ideas', `${themeId}.md`);
  
  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }
    
    const text = fs.readFileSync(themeFile, 'utf8');
    const lines = text.split('\n');
    
    let modified = false;
    const newLines = lines.map(line => {
      // Checked markdown list item: - [x] or - [ ]
      const checkedMatch = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$/);
      if (checkedMatch && checkedMatch[4].trim() === ideaText.trim()) {
        modified = true;
        if (archived) {
          return `${checkedMatch[1]}x${checkedMatch[3]}${checkedMatch[4]}`;
        } else {
          // Convert back to plain bullet: - text
          return `${checkedMatch[1].slice(0, -1)}${checkedMatch[4]}`;
        }
      }
      
      // Plain bullet list item: - text
      const bulletMatch = line.match(/^(\s*[-*+]\s+)(.+)$/);
      if (bulletMatch && bulletMatch[2].trim() === ideaText.trim()) {
        modified = true;
        if (archived) {
          // Convert to checked item: - [x] text
          return `${bulletMatch[1]}[x] ${bulletMatch[2]}`;
        } else {
          // Keep as plain bullet
          return line;
        }
      }
      
      // Plain line (no bullets)
      const plainTrim = line.trim();
      if (!checkedMatch && !bulletMatch && plainTrim === ideaText.trim() && !line.startsWith('#')) {
        modified = true;
        if (archived) {
          return `- [x] ${line}`;
        } else {
          return line;
        }
      }
      
      return line;
    });
    
    if (modified) {
      fs.writeFileSync(themeFile, newLines.join('\n'), 'utf8');
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error toggling idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Edit an idea's text (preserve its checkbox state / prefix style)
app.post('/api/ideas/edit', (req, res) => {
  const { themeId, oldText, newText } = req.body;
  if (!themeId || !oldText || typeof newText !== 'string' || !newText.trim()) {
    return res.status(400).json({ error: 'Theme ID, old text, and new text are required' });
  }

  const themeFile = path.join(workspaceDir, 'ideas', `${themeId}.md`);

  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }

    const text = fs.readFileSync(themeFile, 'utf8');
    const lines = text.split('\n');
    const target = oldText.trim();
    const replacement = newText.trim();
    let modified = false;

    const newLines = lines.map(line => {
      // Checked list item: - [x] text  or  - [ ] text
      const checkedMatch = line.match(/^(\s*[-*+]\s+\[[ xX]\]\s+)(.+)$/);
      if (checkedMatch && checkedMatch[2].trim() === target) {
        modified = true;
        return checkedMatch[1] + replacement;
      }
      // Plain bullet: - text
      const bulletMatch = line.match(/^(\s*[-*+]\s+)(.+)$/);
      if (bulletMatch && bulletMatch[2].trim() === target) {
        modified = true;
        return bulletMatch[1] + replacement;
      }
      // Plain line
      const plainTrim = line.trim();
      if (plainTrim === target && !line.startsWith('#')) {
        modified = true;
        // Preserve any leading whitespace
        const ws = line.match(/^(\s*)/)[1];
        return ws + replacement;
      }
      return line;
    });

    if (modified) {
      fs.writeFileSync(themeFile, newLines.join('\n'), 'utf8');
    }

    res.json({ success: true, modified });
  } catch (err) {
    console.error('Error editing idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete an idea entirely from a theme file
app.post('/api/ideas/delete', (req, res) => {
  const { themeId, ideaText } = req.body;
  if (!themeId || !ideaText) {
    return res.status(400).json({ error: 'Theme ID and idea text are required' });
  }

  const themeFile = path.join(workspaceDir, 'ideas', `${themeId}.md`);

  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }

    const text = fs.readFileSync(themeFile, 'utf8');
    const lines = text.split('\n');
    const target = ideaText.trim();
    let removed = false;

    const newLines = lines.filter(line => {
      if (removed) return true; // only delete the first match
      const checkedMatch = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/);
      if (checkedMatch && checkedMatch[1].trim() === target) { removed = true; return false; }
      const bulletMatch = line.match(/^\s*[-*+]\s+(.+)$/);
      if (bulletMatch && bulletMatch[1].trim() === target) { removed = true; return false; }
      const plainTrim = line.trim();
      if (plainTrim === target && !line.startsWith('#')) { removed = true; return false; }
      return true;
    });

    if (removed) {
      fs.writeFileSync(themeFile, newLines.join('\n'), 'utf8');
    }

    res.json({ success: true, removed });
  } catch (err) {
    console.error('Error deleting idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add an idea to a theme file
app.post('/api/ideas/add', (req, res) => {
  const { themeId, ideaText } = req.body;
  if (!themeId || !ideaText || (typeof ideaText === 'string' && !ideaText.trim())) {
    return res.status(400).json({ error: 'Theme ID and idea text are required' });
  }
  
  const themeFile = path.join(workspaceDir, 'ideas', `${themeId}.md`);
  
  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }
    
    let text = fs.readFileSync(themeFile, 'utf8');
    // Ensure trailing newline
    if (text && !text.endsWith('\n')) {
      text += '\n';
    }
    
    let formatted = '';
    if (Array.isArray(ideaText)) {
      ideaText.forEach(t => {
        if (t && typeof t === 'string' && t.trim()) {
          formatted += `- ${t.trim()}\n`;
        }
      });
    } else if (typeof ideaText === 'string') {
      formatted = `- ${ideaText.trim()}\n`;
    }
    
    fs.writeFileSync(themeFile, text + formatted, 'utf8');
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error adding idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create theme
app.post('/api/themes', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Theme name is required' });
  
  const themeId = safeFilename(name);
  const themeFile = path.join(workspaceDir, 'ideas', `${themeId}.md`);
  
  try {
    if (fs.existsSync(themeFile)) {
      return res.status(400).json({ error: 'Theme file already exists' });
    }
    
    const content = `# ${name.trim()}\n\n`;
    fs.writeFileSync(themeFile, content, 'utf8');
    res.json({ success: true, theme: { id: themeId, name: name.trim(), ideas: [] } });
  } catch (err) {
    console.error('Error creating theme:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete theme
app.delete('/api/themes', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID is required' });
  
  const themeFile = path.join(workspaceDir, 'ideas', `${id}.md`);
  
  try {
    if (fs.existsSync(themeFile)) {
      fs.unlinkSync(themeFile);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting theme:', err);
    res.status(500).json({ error: err.message });
  }
});

// Import documents via drag and drop of file contents
app.post('/api/documents/import', (req, res) => {
  const { sectionId, filename, fileContent } = req.body;
  if (!sectionId || !filename || !fileContent) {
    return res.status(400).json({ error: 'Section, filename, and content required' });
  }
  
  try {
    const sectionFolder = sectionId === '_general' ? workspaceDir : path.join(workspaceDir, sectionId);
    if (!fs.existsSync(sectionFolder)) {
      fs.mkdirSync(sectionFolder, { recursive: true });
    }
    
    let targetFilename = filename;
    let targetPath = path.join(sectionFolder, targetFilename);
    if (fs.existsSync(targetPath)) {
      let index = 1;
      const base = filename.replace(/\.(md|txt)$/i, '');
      const ext = filename.match(/\.(md|txt)$/i)?.[0] || '.md';
      while (fs.existsSync(path.join(sectionFolder, `${base}-${index}${ext}`))) {
        index++;
      }
      targetFilename = `${base}-${index}${ext}`;
      targetPath = path.join(sectionFolder, targetFilename);
    }
    
    fs.writeFileSync(targetPath, fileContent, 'utf8');
    const id = sectionId === '_general' ? `_general/${targetFilename}` : `${sectionId}/${targetFilename}`;
    const fileStat = fs.statSync(targetPath);
    const docInfo = parseMarkdownDoc(fileContent, targetFilename);
    
    res.json({
      success: true,
      document: {
        id,
        filename: targetFilename,
        title: docInfo.title,
        subtitle: docInfo.subtitle,
        content: docInfo.body,
        createdAt: fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs
      }
    });
  } catch (err) {
    console.error('Error importing document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Import theme via drag and drop of file contents
app.post('/api/themes/import', (req, res) => {
  const { filename, fileContent } = req.body;
  if (!filename || !fileContent) {
    return res.status(400).json({ error: 'Filename and content required' });
  }
  
  try {
    const ideasDir = path.join(workspaceDir, 'ideas');
    if (!fs.existsSync(ideasDir)) {
      fs.mkdirSync(ideasDir, { recursive: true });
    }
    
    let themeId = filename.replace(/\.(md|markdown|txt)$/i, '');
    let targetFilename = `${themeId}.md`;
    let targetPath = path.join(ideasDir, targetFilename);
    
    if (fs.existsSync(targetPath)) {
      let index = 1;
      while (fs.existsSync(path.join(ideasDir, `${themeId}-${index}.md`))) {
        index++;
      }
      themeId = `${themeId}-${index}`;
      targetFilename = `${themeId}.md`;
      targetPath = path.join(ideasDir, targetFilename);
    }
    
    fs.writeFileSync(targetPath, fileContent, 'utf8');
    const theme = parseIdeasFile(fileContent, targetFilename);
    
    res.json({
      success: true,
      theme: {
        id: themeId,
        name: theme.themeName,
        ideas: theme.ideas
      }
    });
  } catch (err) {
    console.error('Error importing theme:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Scriptorium server running at http://localhost:${PORT}`);
  console.log(`Workspace directory: ${workspaceDir}`);
});
