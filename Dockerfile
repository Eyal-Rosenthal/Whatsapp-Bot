# Use official Node.js 18 image
FROM node:18

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json, then install dependencies
COPY package*.json ./

# Install dependencies and verify secret-manager installation
RUN npm install && npm list @google-cloud/secret-manager

# Copy application source code
COPY . .

# Set environment variable for the port
ENV PORT=8080

# Log startup and run the app
CMD node -e "console.log('Starting server...'); require('./server.js')"
