"use strict";
/**
 * FileLockManager - Implémentation simple de verrouillage de fichiers
 *
 * Cette implémentation utilise un système de verrouillage basé sur des fichiers .lock
 * qui fonctionne avec le mock fs existant dans les tests.
 *
 * @module FileLockManager.simple
 * @version 2.0.0
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileLockManager = void 0;
exports.getFileLockManager = getFileLockManager;
var fs_1 = require("fs");
/**
 * Gestionnaire de verrouillage de fichiers
 *
 * Utilise des fichiers .lock pour prévenir les accès concurrents.
 */
var FileLockManager = /** @class */ (function () {
    function FileLockManager() {
        this.locks = new Map();
        this.defaultOptions = {
            retries: 10,
            minTimeout: 100,
            maxTimeout: 500,
            stale: 10000
        };
        // Constructeur privé pour le singleton
    }
    /**
     * Obtenir l'instance singleton
     */
    FileLockManager.getInstance = function () {
        if (!FileLockManager.instance) {
            FileLockManager.instance = new FileLockManager();
        }
        return FileLockManager.instance;
    };
    /**
     * Acquérir un verrou sur un fichier
     *
     * @param filePath - Chemin du fichier à verrouiller
     * @param options - Options de verrouillage
     * @returns Fonction de libération du verrou
     */
    FileLockManager.prototype.acquireLock = function (filePath, options) {
        return __awaiter(this, void 0, void 0, function () {
            var lockFilePath, opts, _loop_1, attempt, state_1;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        lockFilePath = this.getLockFilePath(filePath);
                        opts = __assign(__assign({}, this.defaultOptions), options);
                        _loop_1 = function (attempt) {
                            var error_1, lockContent, lockData, age, _b, _c, delay_1;
                            return __generator(this, function (_d) {
                                switch (_d.label) {
                                    case 0:
                                        _d.trys.push([0, 2, , 16]);
                                        // Créer le fichier de verrou
                                        return [4 /*yield*/, fs_1.promises.writeFile(lockFilePath, JSON.stringify({
                                                pid: process.pid,
                                                timestamp: Date.now()
                                            }), { flag: 'wx' })];
                                    case 1:
                                        // Créer le fichier de verrou
                                        _d.sent(); // 'wx' = échoue si le fichier existe
                                        return [2 /*return*/, { value: function () { return __awaiter(_this, void 0, void 0, function () {
                                                    return __generator(this, function (_a) {
                                                        switch (_a.label) {
                                                            case 0: return [4 /*yield*/, this.releaseLock(filePath)];
                                                            case 1:
                                                                _a.sent();
                                                                return [2 /*return*/];
                                                        }
                                                    });
                                                }); } }];
                                    case 2:
                                        error_1 = _d.sent();
                                        if (!(error_1.code === 'EEXIST')) return [3 /*break*/, 14];
                                        _d.label = 3;
                                    case 3:
                                        _d.trys.push([3, 7, , 12]);
                                        return [4 /*yield*/, fs_1.promises.readFile(lockFilePath, 'utf-8')];
                                    case 4:
                                        lockContent = _d.sent();
                                        lockData = JSON.parse(lockContent);
                                        age = Date.now() - lockData.timestamp;
                                        if (!(age > opts.stale)) return [3 /*break*/, 6];
                                        // Le verrou est stale, le supprimer
                                        return [4 /*yield*/, fs_1.promises.unlink(lockFilePath)];
                                    case 5:
                                        // Le verrou est stale, le supprimer
                                        _d.sent();
                                        return [2 /*return*/, "continue"];
                                    case 6: return [3 /*break*/, 12];
                                    case 7:
                                        _b = _d.sent();
                                        _d.label = 8;
                                    case 8:
                                        _d.trys.push([8, 10, , 11]);
                                        return [4 /*yield*/, fs_1.promises.unlink(lockFilePath)];
                                    case 9:
                                        _d.sent();
                                        return [3 /*break*/, 11];
                                    case 10:
                                        _c = _d.sent();
                                        return [3 /*break*/, 11];
                                    case 11: return [2 /*return*/, "continue"];
                                    case 12:
                                        delay_1 = opts.minTimeout + Math.random() * (opts.maxTimeout - opts.minTimeout);
                                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, delay_1); })];
                                    case 13:
                                        _d.sent();
                                        return [3 /*break*/, 15];
                                    case 14: 
                                    // Autre erreur, propager
                                    throw error_1;
                                    case 15: return [3 /*break*/, 16];
                                    case 16: return [2 /*return*/];
                                }
                            });
                        };
                        attempt = 0;
                        _a.label = 1;
                    case 1:
                        if (!(attempt < opts.retries)) return [3 /*break*/, 4];
                        return [5 /*yield**/, _loop_1(attempt)];
                    case 2:
                        state_1 = _a.sent();
                        if (typeof state_1 === "object")
                            return [2 /*return*/, state_1.value];
                        _a.label = 3;
                    case 3:
                        attempt++;
                        return [3 /*break*/, 1];
                    case 4: throw new Error("Impossible d'acqu\u00E9rir le verrou sur ".concat(filePath, " apr\u00E8s ").concat(opts.retries, " tentatives"));
                }
            });
        });
    };
    /**
     * Libérer un verrou
     *
     * @param filePath - Chemin du fichier verrouillé
     */
    FileLockManager.prototype.releaseLock = function (filePath) {
        return __awaiter(this, void 0, void 0, function () {
            var lockFilePath, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        lockFilePath = this.getLockFilePath(filePath);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs_1.promises.unlink(lockFilePath)];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        error_2 = _a.sent();
                        if (error_2.code !== 'ENOENT') {
                            // Ignorer si le fichier n'existe pas déjà
                            throw error_2;
                        }
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Vérifier si un fichier est verrouillé
     *
     * @param filePath - Chemin du fichier à vérifier
     * @returns true si le fichier est verrouillé
     */
    FileLockManager.prototype.isLocked = function (filePath) {
        return __awaiter(this, void 0, void 0, function () {
            var lockFilePath, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        lockFilePath = this.getLockFilePath(filePath);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs_1.promises.access(lockFilePath)];
                    case 2:
                        _b.sent();
                        return [2 /*return*/, true];
                    case 3:
                        _a = _b.sent();
                        return [2 /*return*/, false];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Exécuter une opération avec verrou
     *
     * @param filePath - Chemin du fichier
     * @param operation - Opération à exécuter
     * @param options - Options de verrouillage
     * @returns Résultat de l'opération
     */
    FileLockManager.prototype.withLock = function (filePath, operation, options) {
        return __awaiter(this, void 0, void 0, function () {
            var release, data, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.acquireLock(filePath, options)];
                    case 1:
                        release = _a.sent();
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, 5, 7]);
                        return [4 /*yield*/, operation()];
                    case 3:
                        data = _a.sent();
                        return [2 /*return*/, { success: true, data: data }];
                    case 4:
                        error_3 = _a.sent();
                        return [2 /*return*/, { success: false, error: error_3 }];
                    case 5: return [4 /*yield*/, release()];
                    case 6:
                        _a.sent();
                        return [7 /*endfinally*/];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Lire un fichier avec verrou
     *
     * @param filePath - Chemin du fichier
     * @returns Contenu du fichier
     */
    FileLockManager.prototype.readWithLock = function (filePath) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                return [2 /*return*/, this.withLock(filePath, function () { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0: return [4 /*yield*/, fs_1.promises.readFile(filePath, 'utf-8')];
                                case 1: return [2 /*return*/, _a.sent()];
                            }
                        });
                    }); })];
            });
        });
    };
    /**
     * Écrire dans un fichier avec verrou
     *
     * @param filePath - Chemin du fichier
     * @param data - Données à écrire
     * @returns Résultat de l'opération
     */
    FileLockManager.prototype.writeWithLock = function (filePath, data) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                return [2 /*return*/, this.withLock(filePath, function () { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0: return [4 /*yield*/, fs_1.promises.writeFile(filePath, data, 'utf-8')];
                                case 1:
                                    _a.sent();
                                    return [2 /*return*/];
                            }
                        });
                    }); })];
            });
        });
    };
    /**
     * Mettre à jour un fichier JSON avec verrou
     *
     * @param filePath - Chemin du fichier
     * @param updater - Fonction de mise à jour
     * @param options - Options de verrouillage
     * @returns Résultat de l'opération
     */
    FileLockManager.prototype.updateJsonWithLock = function (filePath, updater, options) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                return [2 /*return*/, this.withLock(filePath, function () { return __awaiter(_this, void 0, void 0, function () {
                        var content, data, updated;
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0: return [4 /*yield*/, fs_1.promises.readFile(filePath, 'utf-8')];
                                case 1:
                                    content = _a.sent();
                                    data = JSON.parse(content);
                                    updated = updater(data);
                                    return [4 /*yield*/, fs_1.promises.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8')];
                                case 2:
                                    _a.sent();
                                    return [2 /*return*/, updated];
                            }
                        });
                    }); }, options)];
            });
        });
    };
    /**
     * Obtenir le chemin du fichier de verrou
     *
     * @param filePath - Chemin du fichier original
     * @returns Chemin du fichier de verrou
     */
    FileLockManager.prototype.getLockFilePath = function (filePath) {
        return "".concat(filePath, ".lock");
    };
    return FileLockManager;
}());
exports.FileLockManager = FileLockManager;
/**
 * Obtenir l'instance singleton de FileLockManager
 *
 * @returns Instance de FileLockManager
 */
function getFileLockManager() {
    return FileLockManager.getInstance();
}
/**
 * Export par défaut
 */
exports.default = FileLockManager;
