@echo off
cd /d "%~dp0"

title Scriptorium Launcher

REM Vérifier si node_modules existe
if not exist "node_modules\" (
    echo Installation des dependances...
    call npm install
)

REM Démarrer le serveur dans une nouvelle fenêtre
echo Demarrage du serveur Scriptorium...
start "Serveur Scriptorium" cmd /c "npm start"

REM Attendre 3 secondes que le serveur s'initialise
echo Attente du demarrage...
ping -n 4 127.0.0.1 > nul

REM Ouvrir le navigateur par défaut
echo Ouverture dans le navigateur...
start http://localhost:3000

echo Scriptorium est lance. Vous pouvez fermer cette fenetre.
ping -n 3 127.0.0.1 > nul