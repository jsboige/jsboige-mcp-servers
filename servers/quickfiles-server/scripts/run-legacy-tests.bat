@echo off
echo ===================================================
echo Test des fonctionnalites legacy du MCP Quickfiles
echo ===================================================
echo.

echo Etape 1: Compilation du code TypeScript
call npm run build
if %errorlevel% neq 0 (
    echo Erreur lors de la compilation
    pause
    exit /b %errorlevel%
)
echo Compilation reussie
echo.

echo Etape 2: Test d'extraction de structure markdown
echo ---------------------------------------------------
echo Execution du test d'extraction de structure markdown...
pushd legacy-tests
call npx ts-node test-markdown-structure.js
if %errorlevel% neq 0 (
    echo Attention: Test d'extraction de structure markdown echoue
) else (
    echo Test d'extraction de structure markdown reussi
)
echo.

echo Etape 3: Test des operations de fichiers
echo ---------------------------------------------------
echo Execution du test des operations de fichiers...
call node test-file-operations.js
if %errorlevel% neq 0 (
    echo Attention: Test des operations de fichiers echoue
) else (
    echo Test des operations de fichiers reussi
)
echo.

echo Etape 4: Test integre de toutes les fonctionnalites
echo ---------------------------------------------------
echo Execution du test integre...
call node test-all-features.js
popd
if %errorlevel% neq 0 (
    echo Attention: Test integre echoue
) else (
    echo Test integre reussi
)
echo.

echo ===================================================
echo Tests termines
echo ===================================================