# Use official Node.js 18 image
FROM node:18

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Verify installation of @google-cloud/secret-manager and all modules
RUN echo "Listing installed node modules:" \
    && npm ls @google-cloud/secret-manager || echo "@google-cloud/secret-manager NOT found!" \
    && echo "Listing all top-level modules:" \
    && ls -l node_modules

# Copy application source code
COPY . .

# Set environment variable for the port
ENV PORT=8080

# Add startup log before running the app
CMD node -e "console.log('Starting server from Docker CMD...'); require('./server.js')"
