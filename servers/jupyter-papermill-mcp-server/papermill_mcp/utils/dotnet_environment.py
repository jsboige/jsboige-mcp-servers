"""
Injection des variables d'environnement .NET pour resolution definitive Microsoft.ML MCP.

Solution technique SDDD basee sur l'analyse des documents 20-SYNTHESE et 21-ANALYSE-ARCHITECTURE.
"""

import os
import platform
import subprocess
import logging
from pathlib import Path
from typing import Dict, Optional, ContextManager
from contextlib import contextmanager

logger = logging.getLogger(__name__)


class DotNetEnvironmentInjector:
    """
    Injecteur d'environnement .NET pour resoudre les problemes NuGet via MCP.
    
    Cause racine identifiee : Heritage d'environnement insuffisant du processus MCP 
    parent vers le kernel .NET enfant via papermill.execute_notebook().
    """
    
    def __init__(self):
        self._detected_paths: Optional[Dict[str, str]] = None
    
    def _detect_dotnet_paths(self) -> Dict[str, str]:
        """
        Auto-detection des chemins .NET critiques pour l'injection d'environnement.
        
        Returns:
            Dict des variables d'environnement .NET detectees
        """
        if self._detected_paths is not None:
            return self._detected_paths
            
        paths = {}
        
        try:
            # 1. DOTNET_ROOT - Racine de l'installation .NET
            if platform.system() == "Windows":
                dotnet_root = Path("C:/Program Files/dotnet")
                if dotnet_root.exists():
                    paths["DOTNET_ROOT"] = str(dotnet_root)
                else:
                    # Fallback: essayer de detecter via 'dotnet --info'
                    result = subprocess.run(['dotnet', '--info'], 
                                          capture_output=True, text=True, timeout=10)
                    if result.returncode == 0:
                        for line in result.stdout.split('\n'):
                            if 'Base Path:' in line:
                                base_path = line.split('Base Path:')[1].strip()
                                # Base Path pointe vers SDK, on remonte vers la racine
                                dotnet_root = Path(base_path).parent.parent
                                paths["DOTNET_ROOT"] = str(dotnet_root)
                                break
            
            # 2. Detecter la version SDK actuelle
            sdk_version = self._detect_current_sdk_version()
            if sdk_version and paths.get("DOTNET_ROOT"):
                dotnet_root = Path(paths["DOTNET_ROOT"])
                sdk_path = dotnet_root / "sdk" / sdk_version
                
                if sdk_path.exists():
                    paths["MSBuildExtensionsPath"] = str(sdk_path)
                    paths["MSBuildSDKsPath"] = str(sdk_path / "Sdks")
                    paths["MSBuildToolsPath"] = str(sdk_path)
            
            # 3. NUGET_PACKAGES - Cache des packages NuGet
            user_profile = os.path.expanduser("~")
            nuget_packages = Path(user_profile) / ".nuget" / "packages"
            if nuget_packages.exists():
                paths["NUGET_PACKAGES"] = str(nuget_packages)
            
            # 4. MSBuildUserExtensionsPath
            msbuild_user = Path(user_profile) / "AppData" / "Local" / "Microsoft" / "MSBuild"
            if platform.system() == "Windows" and msbuild_user.exists():
                paths["MSBuildUserExtensionsPath"] = str(msbuild_user)
            
            # 5. PACKAGEMANAGEMENT_HOME
            package_mgmt = Path(user_profile) / ".packagemanagement"
            if package_mgmt.exists():
                paths["PACKAGEMANAGEMENT_HOME"] = str(package_mgmt)
            
            # 6. Variables de configuration .NET Interactive
            paths["DOTNET_INTERACTIVE_CLI_TELEMETRY_OPTOUT"] = "1"
            paths["DOTNET_NOLOGO"] = "1"
            
            logger.info(f"[OK] Detected .NET environment paths: {len(paths)} variables")
            for key, value in paths.items():
                logger.debug(f"  {key}={value}")
                
        except Exception as e:
            logger.warning(f"Failed to detect .NET paths: {e}")
            
        self._detected_paths = paths
        return paths
    
    def _detect_current_sdk_version(self) -> Optional[str]:
        """Detecte la version SDK .NET actuellement active."""
        try:
            result = subprocess.run(['dotnet', '--version'], 
                                  capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                version = result.stdout.strip()
                logger.debug(f"Detected .NET SDK version: {version}")
                return version
        except Exception as e:
            logger.debug(f"Could not detect SDK version: {e}")
        
        return None
    
    @contextmanager
    def inject_dotnet_environment(self) -> ContextManager[Dict[str, str]]:
        """
        Context manager pour injection temporaire de l'environnement .NET.
        
        Usage:
            with injector.inject_dotnet_environment() as env_vars:
                # Les variables .NET sont injectees dans os.environ
                pm.execute_notebook(...)
                # Les variables sont automatiquement restaurees apres
        
        Yields:
            Dict des variables injectees pour logging/debug
        """
        dotnet_vars = self._detect_dotnet_paths()
        
        if not dotnet_vars:
            logger.warning("WARNING: No .NET environment variables detected - injection skipped")
            yield {}
            return
        
        # Sauvegarder l'environnement actuel
        original_env = {}
        injected_vars = {}
        
        try:
            # Injection des variables .NET
            for key, value in dotnet_vars.items():
                if key in os.environ:
                    original_env[key] = os.environ[key]
                else:
                    original_env[key] = None
                    
                os.environ[key] = value
                injected_vars[key] = value
            
            logger.info(f"Injected {len(injected_vars)} .NET environment variables")
            
            yield injected_vars
            
        finally:
            # Restauration de l'environnement original
            for key, original_value in original_env.items():
                if original_value is None:
                    # Variable n'existait pas, la supprimer
                    if key in os.environ:
                        del os.environ[key]
                else:
                    # Restaurer la valeur originale
                    os.environ[key] = original_value
            
            logger.debug("? .NET environment variables restored")
    
    def validate_environment(self) -> Dict[str, bool]:
        """
        Valide que l'environnement .NET est correctement configure.
        
        Returns:
            Dict[variable_name, is_valid] pour chaque variable critique
        """
        validation_results = {}
        dotnet_vars = self._detect_dotnet_paths()
        
        for key, value in dotnet_vars.items():
            if key in ["DOTNET_INTERACTIVE_CLI_TELEMETRY_OPTOUT", "DOTNET_NOLOGO"]:
                # Variables de configuration - toujours valides si detectees
                validation_results[key] = True
            else:
                # Variables de chemin - valider que le chemin existe
                validation_results[key] = Path(value).exists() if value else False
        
        return validation_results


# Instance globale pour le serveur MCP
_dotnet_injector: Optional[DotNetEnvironmentInjector] = None


def get_dotnet_injector() -> DotNetEnvironmentInjector:
    """Obtient l'instance globale de l'injecteur d'environnement .NET."""
    global _dotnet_injector
    if _dotnet_injector is None:
        _dotnet_injector = DotNetEnvironmentInjector()
    return _dotnet_injector


def inject_dotnet_environment():
    """Raccourci pour l'injection d'environnement .NET."""
    return get_dotnet_injector().inject_dotnet_environment()