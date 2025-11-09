# Script de capture des logs de diagnostic du flux de contenu
# Mission: Tracer la transformation du contenu depuis le fichier source jusqu'au parser

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "🔍 CAPTURE DES LOGS DE DIAGNOSTIC" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Définir une tâche avec un update_todo_list connu
$taskId = "roo_task_aug-4-2025_12-42-53-pm"
$taskPath = "g:/Mon Drive/MyIA/Comptes/Pauwels Consulting/Pauwels Consulting - Formation IA/corriges/atelier-1-matching-cv"

Write-Host "📋 Tâche de test: $taskId" -ForegroundColor Yellow
Write-Host "📁 Emplacement: $taskPath" -ForegroundColor Yellow
Write-Host ""

Write-Host "⚠️  ÉTAPES À SUIVRE:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Assurez-vous que VSCode a été redémarré" -ForegroundColor White
Write-Host "2. Ouvrez un terminal et utilisez le MCP roo-state-manager" -ForegroundColor White
Write-Host "3. Exécutez la génération de trace suivante:" -ForegroundColor White
Write-Host ""
Write-Host "   Commande MCP à utiliser depuis Roo:" -ForegroundColor Cyan
Write-Host "   generate_trace_summary avec taskId='$taskId'" -ForegroundColor Green
Write-Host ""
Write-Host "4. Observez les logs dans le terminal du serveur MCP" -ForegroundColor White
Write-Host ""
Write-Host "📊 LOGS À RECHERCHER:" -ForegroundColor Yellow
Write-Host ""
Write-Host "   [DIAGNOSTIC parseMarkdownSections] - Contenu extrait du .md" -ForegroundColor Magenta
Write-Host "   [DIAGNOSTIC processAssistantContent] - Contenu avant parsing" -ForegroundColor Magenta
Write-Host ""
Write-Host "🔍 VÉRIFICATIONS CLÉS:" -ForegroundColor Yellow
Write-Host ""
Write-Host "   • Les balises sont-elles <tool> ou &lt;tool&gt; dans parseMarkdownSections?" -ForegroundColor White
Write-Host "   • Les balises sont-elles <tool> ou &lt;tool&gt; dans processAssistantContent?" -ForegroundColor White
Write-Host "   • Y a-t-il une transformation entre les deux?" -ForegroundColor White
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Appuyez sur une touche pour continuer..." -ForegroundColor Gray
Write-Host "================================================" -ForegroundColor Cyan

$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")