#!/usr/bin/env python3
"""
CORRECTION CRITIQUE UNICODE - Supprime TOUS les caracteres non-ASCII
Resout le crash conda Windows cp1252 qui empeche le serveur de fonctionner
"""

import os
import re
from pathlib import Path

# Mappings de remplacement pour caracteres Unicode critiques
UNICODE_REPLACEMENTS = {
    # Emojis de statut
    '[OK]': '[OK]',
    '[ERROR]': '[ERROR]', 
    '[WARNING]': '[WARNING]',
    '[SEARCH]': '[SEARCH]',
    '[NOTE]': '[NOTE]',
    '[PLUGIN]': '[PLUGIN]',
    '[SUCCESS]': '[SUCCESS]',
    '[START]': '[START]',
    '[STOP]': '[STOP]',
    '[CRASH]': '[CRASH]',
    '[CRITICAL]': '[CRITICAL]',
    '[TARGET]': '[TARGET]',
    '[STATS]': '[STATS]',
    '[TEST]': '[TEST]',
    '[TOOL]': '[TOOL]',
    
    # Caracteres francais
    'e': 'e',
    'e': 'e', 
    'e': 'e',
    'e': 'e',
    'a': 'a',
    'a': 'a',
    'c': 'c',
    'i': 'i',
    'o': 'o',
    'u': 'u',
    'u': 'u',
    'u': 'u',
    
    # Mots francais frequents
    'reussi': 'reussi',
    'reussie': 'reussie',
    'cree': 'cree',
    'creee': 'creee',
    'echec': 'echec',
    'echoue': 'echoue',
    'verifie': 'verifie',
    'execute': 'execute',
    'execution': 'execution',
    'parametres': 'parametres',
    'systeme': 'systeme',
    'operation': 'operation',
    'generee': 'generee',
    'genere': 'genere',
    'generes': 'generes',
}

def clean_unicode_from_text(text):
    """Remplace tous les caracteres Unicode par des equivalents ASCII"""
    
    # Remplacement direct des mappings
    for unicode_char, ascii_replacement in UNICODE_REPLACEMENTS.items():
        text = text.replace(unicode_char, ascii_replacement)
    
    # Supprimer tous les autres caracteres non-ASCII
    text = re.sub(r'[^\x00-\x7F]', '?', text)
    
    return text

def fix_file_unicode(file_path):
    """Corrige les caracteres Unicode dans un fichier"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Verifier s'il y a des caracteres non-ASCII
        if not all(ord(char) < 128 for char in content):
            original_count = len([c for c in content if ord(c) >= 128])
            
            # Nettoyer le contenu
            clean_content = clean_unicode_from_text(content)
            
            # ?crire le contenu nettoye
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(clean_content)
            
            return original_count
        
        return 0
        
    except Exception as e:
        print(f"ERROR fixing {file_path}: {e}")
        return -1

def main():
    """Correction systematique de tous les fichiers Python"""
    print("CORRECTION CRITIQUE UNICODE - Suppression caracteres non-ASCII")
    print("=" * 60)
    
    # Repertoires a traiter
    base_dir = Path('.')
    python_files = list(base_dir.rglob('*.py'))
    
    total_files = 0
    total_fixes = 0
    total_unicode_chars = 0
    
    for py_file in python_files:
        # Ignorer les fichiers dans __pycache__
        if '__pycache__' in str(py_file):
            continue
            
        unicode_count = fix_file_unicode(py_file)
        
        if unicode_count > 0:
            print(f"FIXED {py_file}: {unicode_count} caracteres Unicode")
            total_fixes += 1
            total_unicode_chars += unicode_count
        elif unicode_count == 0:
            pass  # Fichier deja clean
        else:
            print(f"ERROR {py_file}: Echec de correction")
        
        total_files += 1
    
    print("=" * 60)
    print("RESULTATS CORRECTION UNICODE:")
    print(f"  - Fichiers traites: {total_files}")
    print(f"  - Fichiers corriges: {total_fixes}")
    print(f"  - Caracteres Unicode supprimes: {total_unicode_chars}")
    
    if total_unicode_chars > 0:
        print(f"\nCORRECTION CRITIQUE TERMINEE")
        print(f"Le serveur devrait maintenant fonctionner sur Windows")
        return 0
    else:
        print("\nAucun caractere Unicode trouve")
        return 1

if __name__ == "__main__":
    exit(main())