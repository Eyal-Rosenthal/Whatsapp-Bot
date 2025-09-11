# Use official Node.js 18 image
FROM node:18

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application source code
COPY . .

# Set environment variable for the port
ENV PORT=8080

# Add startup log before running the app
CMD node -e "console.log('Starting server from Docker CMD...'); require('./server.js')"
