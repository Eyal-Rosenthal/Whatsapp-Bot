# Use official Node.js 18 image
FROM node:18

# Set working directory inside the container
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install


# Copy all remaining project files
COPY . .
# הגדרת הפורט שהאפליקציה מאזינה עליו (כגון 8080)
ENV PORT=8080

# Start the server
CMD ["node", "server.js"]
