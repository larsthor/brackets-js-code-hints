/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, brackets, $ */

define(function (require, exports, module) {
    "use strict";

    var HintUtils       = require("HintUtils"),
        ScopeManager    = require("ScopeManager");

    /**
     * Session objects encapsulate state associated with a hinting session
     * and provide methods for updating and querying the session.
     */
    function Session(editor) {
        this.editor = editor;
        this.path = editor.document.file.fullPath;
    }

    /**
     * Update the scope information assocated with the current session
     */
    Session.prototype.setScopeInfo = function (scopeInfo) {
        this.scope = scopeInfo.scope;
        this.identifiers = scopeInfo.identifiers;
        this.globals = scopeInfo.globals;
        this.properties = scopeInfo.properties;
        this.literals = scopeInfo.literals;
        this.associations = scopeInfo.associations;
    };

    /**
     * Get the name of the file associated with the current session
     */
    Session.prototype.getPath = function () {
        return this.path;
    };

    /**
     * Get the current cursor position.
     *
     * @return Object<line: number, ch, number>
     */
    Session.prototype.getCursor = function () {
        return this.editor.getCursorPos();
    };
    
    /**
     * Get the offset of the current cursor position
     */
    Session.prototype.getOffset = function () {
        var cursor = this.getCursor();
        
        return this.editor.indexFromPos(cursor);
    };

    /**
     * Get the token at the current cursor position
     */
    Session.prototype.getCurrentToken = function () {
        var cm      = this.editor._codeMirror,
            cursor  = this.getCursor();
            
        return cm.getTokenAt(cursor);
    };
    
    /**
     * Get the token after the one at the given cursor
     */
    Session.prototype.getNextToken = function () {
        var cm      = this.editor._codeMirror,
            cursor  = this.getCursor(),
            doc     = this.editor.document,
            line    = doc.getLine(cursor.line);

        if (cursor.ch < line.length) {
            return cm.getTokenAt({ch: cursor.ch + 1,
                                  line: cursor.line});
        } else if (doc.getLine(cursor.line + 1)) {
            return cm.getTokenAt({ch: 0, line: cursor.line + 1});
        } else {
            return null;
        }
    };
    
    /**
     * Get the token before the one at the given cursor
     */
    Session.prototype._getPreviousToken = function (cursor) {
        var token   = this.editor._codeMirror.getTokenAt(cursor),
            doc     = this.editor.document,
            prev    = token;

        do {
            if (prev.start < cursor.ch) {
                cursor.ch = prev.start;
            } else if (prev.start > 0) {
                cursor.ch = prev.start - 1;
            } else if (cursor.line > 0) {
                cursor.ch = doc.getLine(cursor.line - 1).length;
                cursor.line--;
            } else {
                break;
            }
            prev = this.editor._codeMirror.getTokenAt(cursor);
        } while (prev.string.trim() === "");
        
        return prev;
    };
    
    /**
     * Calculate a query string relative to the current cursor position
     * and token.
     */
    Session.prototype.getQuery = function () {
        var cursor  = this.getCursor(),
            token   = this.getCurrentToken(),
            query   = "";
        
        if (token) {
            if (token.string !== ".") {
                query = token.string.substring(0, token.string.length - (token.end - cursor.ch));
                query = query.trim();
            }
        }
        return query;
    };
    
    /**
     * Find the context of a property lookup.
     */
    Session.prototype.getContext = function (cursor, depth) {
        var cm          = this.editor._codeMirror,
            token       = cm.getTokenAt(cursor);

        if (depth === undefined) {
            depth = 0;
        }

        if (token.string === ")") {
            this._getPreviousToken(cursor);
            return this.getContext(cursor, ++depth);
        } else if (token.string === "(") {
            this._getPreviousToken(cursor);
            return this.getContext(cursor, --depth);
        } else {
            if (depth > 0 || token.string === ".") {
                this._getPreviousToken(cursor);
                return this.getContext(cursor, depth);
            } else {
                return token.string;
            }
        }
    };

    /**
     * Get the type of the type of the current session, i.e., whether it is a
     * property lookup and, if so, what the context of the lookup is. 
     */
    Session.prototype.getType = function () {
        var propertyLookup  = false,
            context         = null,
            cursor          = this.getCursor(),
            token           = this.getCurrentToken();

        if (token) {
            if (token.string === ".") {
                propertyLookup = true;
                context = this.getContext(cursor);
            } else {
                if (token.className === "property") {
                    propertyLookup = true;
                }

                token = this._getPreviousToken(cursor);
                if (token && token.string === ".") {
                    propertyLookup = true;
                    context = this.getContext(cursor);
                }
            }
        }

        return {
            property: propertyLookup,
            context: context
        };
    };

    /**
     * Get a list of hints for the current session using the current scope information. 
     */
    Session.prototype.getHints = function () {
        
        /*
         * Comparator for sorting tokens according to minimum distance from
         * a given position
         */
        function compareByPosition(pos) {
            
            /*
             * Compute the minimum distance between a token, with which is 
             * associated a list of positions, and a given offset
             */
            function mindist(pos, t) {
                var dist = t.positions.length ? Math.abs(t.positions[0] - pos) : Infinity,
                    i,
                    tmp;

                for (i = 1; i < t.positions.length; i++) {
                    tmp = Math.abs(t.positions[i] - pos);
                    if (tmp < dist) {
                        dist = tmp;
                    }
                }
                return dist;
            }

            return function (a, b) {
                var adist = mindist(pos, a),
                    bdist = mindist(pos, b);
                
                if (adist === Infinity) {
                    if (bdist === Infinity) {
                        return 0;
                    } else {
                        return 1;
                    }
                } else {
                    if (bdist === Infinity) {
                        return -1;
                    } else {
                        return adist - bdist;
                    }
                }
            };
        }

        /*
         * Comparator for sorting tokens lexicographically according to scope,
         * assuming the scope level has already been annotated.
         */
        function compareByScope() {
            return function (a, b) {
                var adepth = a.level;
                var bdepth = b.level;

                if (adepth >= 0) {
                    if (bdepth >= 0) {
                        return adepth - bdepth;
                    } else {
                        return -1;
                    }
                } else {
                    if (bdepth >= 0) {
                        return 1;
                    } else {
                        return 0;
                    }
                }
            };
        }
        
        /*
         * Comparator for sorting tokens by name
         */
        function compareByName(a, b) {
            if (a.value === b.value) {
                return 0;
            } else if (a.value < b.value) {
                return -1;
            } else {
                return 1;
            }
        }
        
        /*
         * Comparator for sorting tokens by path, such that
         * a <= b if a.path === path
         */
        function compareByPath(path) {
            return function (a, b) {
                if (a.path === path) {
                    if (b.path === path) {
                        return 0;
                    } else {
                        return -1;
                    }
                } else {
                    if (b.path === path) {
                        return 1;
                    } else {
                        return 0;
                    }
                }
            };
        }
        
        /*
         * Comparator for sorting properties w.r.t. an association object.
         */
        function compareByAssociation(assoc) {
            return function (a, b) {
                if (Object.prototype.hasOwnProperty.call(assoc, a.value)) {
                    if (Object.prototype.hasOwnProperty.call(assoc, b.value)) {
                        return assoc[a.value] - assoc[b.value];
                    } else {
                        return -1;
                    }
                } else {
                    if (Object.prototype.hasOwnProperty.call(assoc, b.value)) {
                        return 1;
                    } else {
                        return 0;
                    }
                }
            };
        }

        /*
         * Forms the lexicographical composition of comparators
         */
        function lexicographic(compare1, compare2) {
            return function (a, b) {
                var result = compare1(a, b);
                if (result === 0) {
                    return compare2(a, b);
                } else {
                    return result;
                }
            };
        }

        /*
         * A comparator for identifiers
         */
        function compareIdentifiers(pos) {
            return lexicographic(compareByScope(),
                        lexicographic(compareByPosition(pos),
                            compareByName));
        }
        
        /*
         * A comparator for properties
         */
        function compareProperties(assoc, path, pos) {
            return lexicographic(compareByAssociation(assoc),
                        lexicographic(compareByPath(path),
                            lexicographic(compareByPosition(pos),
                                compareByName)));
        }
        
        /*
         * Annotate list of identifiers with their scope level
         */
        function annotateIdentifers(identifiers, scope) {
            return identifiers.map(function (t) {
                var level = scope.contains(t.value);
                
                if (level >= 0) {
                    t.level = level;
                } else {
                    t.level = -1;
                }
                return t;
            });
        }
        
        /*
         * Annotate a list of properties with their association level
         */
        function annotateProperties(properties, association) {
            return properties.map(function (t) {
                if (association[t.value] > 0) {
                    t.level = 0;
                }
                return t;
            });
        }
        
        /*
         * Annotate a list of tokens as being global variables
         */
        function annotateGlobals(globals) {
            return globals.map(function (t) {
                t.global = true;
                return t;
            });
        }
        
        /*
         * Annotate a list of tokens as literals of a particular kind;
         * if string literals, annotate with an appropriate delimiter. 
         */
        function annotateLiterals(literals, kind) {
            return literals.map(function (t) {
                t.literal = true;
                t.kind = kind;
                if (t.value.indexOf(HintUtils.DOUBLE_QUOTE) > 0) {
                    if (t.value.indexOf(HintUtils.SINGLE_QUOTE) > 0) {
                        t.delimeter = HintUtils.DOUBLE_QUOTE;
                    } else {
                        t.delimeter = HintUtils.SINGLE_QUOTE;
                    }
                } else {
                    t.delimeter = HintUtils.DOUBLE_QUOTE;
                }
                return t;
            });
        }
        
        /* 
         * Annotate a list of tokens as keywords
         */
        function annotateKeywords(keywords) {
            return keywords.map(function (t) {
                t.keyword = true;
                return t;
            });
        }
        
        /*
         * Clone a list of hints. (Used so that later annotations are not 
         * preserved when scope information changes.)
         */
        function copyHints(hints) {
            function cloneToken(token) {
                var copy = {},
                    prop;
                for (prop in token) {
                    if (Object.prototype.hasOwnProperty.call(token, prop)) {
                        copy[prop] = token[prop];
                    }
                }
                return copy;
            }
            return hints.map(cloneToken);
        }

        var cursor = this.editor.getCursorPos(),
            offset = this.editor.indexFromPos(cursor),
            type = this.getType(),
            association,
            hints;

        if (type.property) {
            hints = copyHints(this.properties);
            if (type.context &&
                    Object.prototype.hasOwnProperty.call(this.associations, type.context)) {
                association = this.associations[type.context];
                hints = annotateProperties(hints, association);
                hints.sort(compareProperties(association, this.path, offset));
            } else {
                hints.sort(compareProperties({}, this.path, offset));
            }
        } else {
            hints = annotateIdentifers(copyHints(this.identifiers), this.scope);
            hints = hints.concat(annotateLiterals(copyHints(this.literals), "string"));
            hints.sort(compareIdentifiers(offset));
            hints = hints.concat(annotateGlobals(this.globals));
            hints = hints.concat(annotateLiterals(HintUtils.LITERALS));
            hints = hints.concat(annotateKeywords(HintUtils.KEYWORDS));
        }
        
        return hints;
    };
    
    exports.Session = Session;
    
});