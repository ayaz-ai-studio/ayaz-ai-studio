#!/bin/bash
# Install Python edge-tts for better Urdu voice quality
pip3 install edge-tts 2>&1 | tail -1
echo "edge-tts installed"
