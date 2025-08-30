#!/bin/bash

# Remote Mouse - Build Script for macOS
# This script creates a standalone .app with your custom icon and installs it to Applications
# The app will open a terminal window to show logs and connection URLs

set -e  # Exit on any error

echo "🚀 Remote Mouse - Building macOS App"
echo "===================================="

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ This script only works on macOS"
    exit 1
fi

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed"
    exit 1
fi

# Check if pip is installed
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is not installed"
    exit 1
fi

# Install PyInstaller if not already installed
echo "📦 Checking PyInstaller..."
if ! python3 -c "import PyInstaller" 2>/dev/null; then
    echo "📦 Installing PyInstaller..."
    pip3 install pyinstaller
else
    echo "✅ PyInstaller already installed"
fi

# Look for existing icon files
ICON_PNG=""
ICON_SVG=""

# Common icon filenames to check
PNG_FILES=("icon.png" "app_icon.png" "remote_mouse.png" "logo.png" "icon-512.png" "icon-1024.png")
SVG_FILES=("icon.svg" "app_icon.svg" "remote_mouse.svg" "logo.svg")

echo "🔍 Looking for existing icon files..."

# Check for PNG files
for file in "${PNG_FILES[@]}"; do
    if [ -f "$file" ]; then
        ICON_PNG="$file"
        echo "✅ Found PNG icon: $ICON_PNG"
        break
    fi
done

# Check for SVG files
for file in "${SVG_FILES[@]}"; do
    if [ -f "$file" ]; then
        ICON_SVG="$file"
        echo "✅ Found SVG icon: $ICON_SVG"
        break
    fi
done

# If no icons found, ask user for filename
if [ -z "$ICON_PNG" ] && [ -z "$ICON_SVG" ]; then
    echo "❌ No icon files found automatically"
    echo "�� Available files in current directory:"
    ls -la *.png *.svg 2>/dev/null || echo "No PNG or SVG files found"
    echo ""
    read -p "📝 Enter your icon filename (PNG or SVG): " ICON_FILE
    if [ -f "$ICON_FILE" ]; then
        if [[ "$ICON_FILE" == *.png ]]; then
            ICON_PNG="$ICON_FILE"
        elif [[ "$ICON_FILE" == *.svg ]]; then
            ICON_SVG="$ICON_FILE"
        fi
    else
        echo "❌ File not found: $ICON_FILE"
        exit 1
    fi
fi

# Create ICNS from PNG or SVG
ICON_PATH="app_icon.icns"
if [ ! -f "$ICON_PATH" ]; then
    echo "�� Converting icon to ICNS format..."
    
    if [ -n "$ICON_PNG" ]; then
        echo "📷 Using PNG icon: $ICON_PNG"
        SOURCE_ICON="$ICON_PNG"
    elif [ -n "$ICON_SVG" ]; then
        echo "🎨 Converting SVG to PNG first..."
        # Convert SVG to PNG using rsvg-convert (install with brew install librsvg)
        if command -v rsvg-convert &> /dev/null; then
            rsvg-convert -w 1024 -h 1024 "$ICON_SVG" -o temp_icon.png
            SOURCE_ICON="temp_icon.png"
        else
            echo "❌ rsvg-convert not found. Install with: brew install librsvg"
            echo "💡 Or convert your SVG to PNG manually and place it in this directory"
            exit 1
        fi
    fi
    
    # Create iconset directory
    mkdir -p app_icon.iconset
    
    # Generate different sizes for macOS
    echo "🔄 Generating icon sizes..."
    sips -z 16 16 "$SOURCE_ICON" --out app_icon.iconset/icon_16x16.png
    sips -z 32 32 "$SOURCE_ICON" --out app_icon.iconset/icon_16x16@2x.png
    sips -z 32 32 "$SOURCE_ICON" --out app_icon.iconset/icon_32x32.png
    sips -z 64 64 "$SOURCE_ICON" --out app_icon.iconset/icon_32x32@2x.png
    sips -z 128 128 "$SOURCE_ICON" --out app_icon.iconset/icon_128x128.png
    sips -z 256 256 "$SOURCE_ICON" --out app_icon.iconset/icon_128x128@2x.png
    sips -z 256 256 "$SOURCE_ICON" --out app_icon.iconset/icon_256x256.png
    sips -z 512 512 "$SOURCE_ICON" --out app_icon.iconset/icon_256x256@2x.png
    sips -z 512 512 "$SOURCE_ICON" --out app_icon.iconset/icon_512x512.png
    sips -z 1024 1024 "$SOURCE_ICON" --out app_icon.iconset/icon_512x512@2x.png
    
    # Create ICNS file
    iconutil -c icns app_icon.iconset
    
    # Clean up
    rm -rf app_icon.iconset
    if [ -f "temp_icon.png" ]; then
        rm temp_icon.png
    fi
    
    echo "✅ App icon created: $ICON_PATH"
else
    echo "✅ App icon already exists: $ICON_PATH"
fi

# Create Info.plist for the app (console mode)
echo "📝 Creating Info.plist..."
cat > Info.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>RemoteMouseServer</string>
    <key>CFBundleIdentifier</key>
    <string>com.remotemouse.server</string>
    <key>CFBundleName</key>
    <string>Remote Mouse</string>
    <key>CFBundleDisplayName</key>
    <string>Remote Mouse</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleIconFile</key>
    <string>app_icon.icns</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
    <key>LSBackgroundOnly</key>
    <false/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoads</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

# Build the executable (console mode - will show terminal window)
echo "🔨 Building executable (console mode)..."
pyinstaller \
    --name "RemoteMouseServer" \
    --onefile \
    --console \
    --icon="$ICON_PATH" \
    --add-data "web:web" \
    --collect-all websockets \
    --collect-all pynput \
    --hidden-import=websockets \
    --hidden-import=pynput \
    --hidden-import=pynput.mouse \
    --hidden-import=pynput.keyboard \
    server/server.py

# Create the .app bundle
echo "📦 Creating .app bundle..."
APP_NAME="Remote Mouse.app"
APP_PATH="dist/$APP_NAME"
CONTENTS_PATH="$APP_PATH/Contents"
MACOS_PATH="$CONTENTS_PATH/MacOS"
RESOURCES_PATH="$CONTENTS_PATH/Resources"

# Create directory structure
mkdir -p "$MACOS_PATH" "$RESOURCES_PATH"

# Copy executable
cp "dist/RemoteMouseServer" "$MACOS_PATH/RemoteMouseServer"

# Copy icon
cp "$ICON_PATH" "$RESOURCES_PATH/"

# Copy Info.plist
cp "Info.plist" "$CONTENTS_PATH/"

# Make executable
chmod +x "$MACOS_PATH/RemoteMouseServer"

# Clean up build files
echo "🧹 Cleaning up build files..."
rm -rf build
rm -rf __pycache__
rm -rf server/__pycache__
rm -f "dist/RemoteMouseServer"

echo "✅ App bundle created: $APP_PATH"

# Ask user if they want to install to Applications
echo ""
read -p "📱 Install to Applications folder? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📱 Installing to Applications..."
    
    # Remove existing app if it exists
    if [ -d "/Applications/$APP_NAME" ]; then
        echo "🗑️  Removing existing app..."
        rm -rf "/Applications/$APP_NAME"
    fi
    
    # Copy to Applications
    cp -R "$APP_PATH" "/Applications/"
    
    # Set permissions
    chmod -R 755 "/Applications/$APP_NAME"
    
    echo "✅ Installed to Applications: /Applications/$APP_NAME"
    echo ""
    echo "🎉 Installation complete!"
    echo ""
    echo "📋 Next steps:"
    echo "1. Open Applications folder"
    echo "2. Double-click 'Remote Mouse' to launch"
    echo "3. A terminal window will open showing server logs"
    echo "4. Grant Accessibility permissions when prompted:"
    echo "   System Settings → Privacy & Security → Accessibility"
    echo "5. The terminal will show connection URLs for your phone"
    echo ""
    echo "�� You can now launch Remote Mouse from Spotlight or Applications!"
    echo "📱 The terminal window will show the connection URLs you need for your phone"
else
    echo "📁 App bundle is ready at: $APP_PATH"
    echo "📱 You can manually copy it to Applications when ready"
fi

echo ""
echo "✨ Build complete!"