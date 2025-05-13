' Script VBScript pour exécuter une commande en arrière-plan sans afficher de terminal
' Usage: wscript run-hidden.vbs <command> <arguments>

' Récupérer les arguments de la ligne de commande
Set args = WScript.Arguments
If args.Count < 1 Then
    WScript.Echo "Usage: wscript run-hidden.vbs <command> <arguments>"
    WScript.Quit 1
End If

' Construire la commande complète
command = args(0)
For i = 1 To args.Count - 1
    command = command & " " & args(i)
Next

' Créer un objet Shell pour exécuter la commande en arrière-plan
Set shell = CreateObject("WScript.Shell")
shell.Run command, 0, False  ' 0 = masquer la fenêtre, False = ne pas attendre la fin de l'exécution

' Terminer le script
WScript.Quit 0