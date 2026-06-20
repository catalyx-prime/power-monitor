UUID        = power-monitor@local
EXT_DIR     = $(HOME)/.local/share/gnome-shell/extensions
INSTALL_DIR = $(EXT_DIR)/$(UUID)
ZIP         = $(UUID).zip

# Files shipped with the extension (icons/ and schemas/ handled separately).
SRC = extension.js prefs.js metadata.json stylesheet.css

.PHONY: all schemas install pack clean

all: schemas

# Compile the bundled GSettings schema.
schemas:
	glib-compile-schemas schemas/

# Install into the user's GNOME Shell extensions directory.
install: schemas
	rm -rf "$(INSTALL_DIR)"
	mkdir -p "$(INSTALL_DIR)"
	cp $(SRC) "$(INSTALL_DIR)/"
	cp -r schemas "$(INSTALL_DIR)/"
	cp -r icons "$(INSTALL_DIR)/" 2>/dev/null || mkdir -p "$(INSTALL_DIR)/icons"
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Restart GNOME Shell (X11: Alt+F2, r) or log out/in, then:"
	@echo "  gnome-extensions enable $(UUID)"

# Produce a distributable zip. Ship the schema *source* only — EGO compiles
# gschemas.compiled itself, and shipping the compiled artifact is flagged by
# review (EGO-P-006), so exclude it from the bundle.
pack:
	rm -f "$(ZIP)"
	zip -r "$(ZIP)" $(SRC) schemas icons -x 'schemas/gschemas.compiled'
	@echo "Created $(ZIP)"

clean:
	rm -f "$(ZIP)" schemas/gschemas.compiled
