# Script pour un test end-to-end autonome du serveur QuickFiles

# Aller dans le bon répertoire
Set-Location $PSScriptRoot

# Fonction pour trouver un port TCP libre
function Get-FreeTcpPort {
    $listener = New-Object System.Net.Sockets.TcpListener('127.0.0.1', 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}
$E2E_PORT = Get-FreeTcpPort
Write-Host "[INFO] Utilisation du port TCP dynamique : $E2E_PORT"

# Etape 1: Compiler le serveur
Write-Host "--- DEBUT: Etape 1: Installation des dépendances et Compilation ---"
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: L'installation des dépendances a échoué avec le code de sortie: $LASTEXITCODE."
    exit 1
}
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: La compilation a échoué avec le code de sortie: $LASTEXITCODE."
    exit 1
}
Write-Host "SUCCES: Compilation terminée."
Write-Host "--- FIN: Etape 1 ---"
Write-Host ""

# Etape 2: Démarrer le serveur en arrière-plan et capturer les logs
Write-Host "--- DEBUT: Etape 2: Démarrage du serveur ---"
$StdOutLog = ".\server-stdout.log"
$StdErrLog = ".\server-stderr.log"
Write-Host "Lancement du processus serveur..."
# Utiliser pwsh pour lancer la commande npm de manière robuste
# Définir la variable d'environnement PORT pour le processus enfant
$env:PORT = $E2E_PORT
$process = Start-Process "pwsh" -ArgumentList "-Command", "`$env:PORT='$E2E_PORT'; npm run start" -PassThru -RedirectStandardOutput $StdOutLog -RedirectStandardError $StdErrLog
if (-not $process) {
    Write-Host "ERREUR: Impossible de démarrer le processus serveur."
    exit 1
}
Write-Host "SUCCES: Serveur démarré avec le PID: $($process.Id)."
Write-Host "Les logs du serveur sont redirigés vers:"
Write-Host "  - STDOUT: $StdOutLog"
Write-Host "  - STDERR: $StdErrLog"
Write-Host "--- FIN: Etape 2 ---"
Write-Host ""

# Etape 3: Attendre l'initialisation du serveur via le Health Check
Write-Host "--- DEBUT: Etape 3: Health Check ---"
$maxAttempts = 20
$attempt = 0
$healthCheckUrl = "http://localhost:$E2E_PORT/health"
$serverReady = $false

try {
    $response = Invoke-RestMethod -Uri $healthCheckUrl -Method Get -TimeoutSec 5 -MaximumRetryCount 20 -RetryIntervalSec 1
    if ($response.status -eq 'ok') {
        Write-Host "SUCCES: Le serveur est prêt !"
        $serverReady = $true
    }
} catch {
    Write-Host "Le serveur n'est pas encore accessible. Erreur: $($_.Exception.Message)."
}

if (-not $serverReady) {
    Write-Host "ERREUR: Le serveur n'a pas répondu après $maxAttempts tentatives. Abandon."
    # Etape de nettoyage: s'assurer que le serveur est bien arrêté
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "--- FIN: Etape 3 ---"
Write-Host ""

# Etape 4: Exécuter le script de test de connexion
Write-Host "--- DEBUT: Etape 4: Exécution du client de test ---"
Write-Host "Lancement du client Node.js (test-connection.js)..."
# Exécute node et capture la sortie. Les erreurs seront aussi affichées.
# Passer le port au script client via une variable d'environnement
$env:E2E_PORT = $E2E_PORT
node ../test-connection.js
$ClientExitCode = $LASTEXITCODE
Write-Host "Client Node.js terminé avec le code de sortie: $ClientExitCode."
Write-Host "--- FIN: Etape 4 ---"
Write-Host ""

# Etape 5: Afficher les logs du serveur
Write-Host "--- DEBUT: Etape 5: Affichage des logs serveur ---"
if (Test-Path $StdOutLog) {
    Write-Host "--- Contenu de STDOUT ($StdOutLog) ---"
    Get-Content $StdOutLog
    Write-Host "--- Fin du contenu STDOUT ---"
} else {
    Write-Host "Le fichier de log STDOUT ($StdOutLog) est introuvable."
}
if (Test-Path $StdErrLog) {
    Write-Host "--- Contenu de STDERR ($StdErrLog) ---"
    Get-Content $StdErrLog
    Write-Host "--- Fin du contenu STDERR ---"
} else {
    Write-Host "Le fichier de log STDERR ($StdErrLog) est introuvable."
}
Write-Host "--- FIN: Etape 5 ---"
Write-Host ""

# Etape 6: Arrêter le serveur
Write-Host "--- DEBUT: Etape 6: Arrêt du serveur ---"
Write-Host "Arrêt du processus serveur avec le PID: $($process.Id)..."
Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
if ($?) {
    Write-Host "Commande d'arrêt envoyée avec succès."
} else {
    Write-Host "AVERTISSEMENT: La commande d'arrêt a échoué. Le processus était peut-être déjà terminé."
}
Write-Host "--- FIN: Etape 6 ---"

Write-Host ""
Write-Host "Script de test E2E terminé."