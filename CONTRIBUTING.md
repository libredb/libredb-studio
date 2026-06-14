# Contributing to LibreDB Studio

First off, thank you for considering contributing to LibreDB Studio! It's people like you that make LibreDB Studio such a great tool.

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Describe the behavior you observed and what you expected**
- **Include screenshots if possible**
- **Include your environment details** (OS, browser, Node.js version)

### Suggesting Features

Feature suggestions are welcome! Please provide:

- **A clear and descriptive title**
- **A detailed description of the proposed feature**
- **Explain why this feature would be useful**
- **Include mockups or examples if applicable**

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Follow the coding style** of the project
3. **Write clear commit messages**
4. **Update documentation** if needed
5. **Test your changes** thoroughly

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) (recommended) or Node.js 24+
- Git

### Getting Started

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/libredb-studio.git
cd libredb-studio

# Install dependencies
bun install

# Copy environment example
cp .env.example .env.local

# Start development server
bun dev
```

### Environment Variables

Required for development:
```env
ADMIN_PASSWORD=admin123
USER_PASSWORD=user123
JWT_SECRET=your_32_character_random_string_here
```

Optional (for AI features):
```env
LLM_PROVIDER=gemini
LLM_API_KEY=your_api_key
LLM_MODEL=gemini-2.5-flash
```

### Development Database

We provide a ready-to-use PostgreSQL setup with sample data for testing:

```bash
# Start PostgreSQL with sample e-commerce data
docker compose -f docker/postgres.yml up -d

# Connect with:
# Host: localhost, Port: 5432, Database: libredb_dev
# User: postgres, Password: postgres
```

**Includes:**
- PostgreSQL 17 with `pg_stat_statements` enabled
- E-commerce sample schema (customers, products, orders)
- 100+ records across multiple tables
- Pre-built views for reporting

> This is especially useful for testing the **Monitoring Dashboard** features.

### Project Structure

```
src/
├── app/              # Next.js App Router
│   ├── api/          # API routes
│   ├── admin/        # Admin pages
│   └── login/        # Login page
├── components/       # React components
├── hooks/            # Custom React hooks
└── lib/
    ├── db/           # Database providers (Strategy Pattern)
    ├── llm/          # LLM providers (Strategy Pattern)
    └── ...           # Utilities
```

### Available Scripts

```bash
bun dev        # Start development server
bun build      # Build for production
bun start      # Start production server
bun lint       # Run ESLint
```

## Coding Guidelines

### TypeScript

- Use TypeScript for all new code
- Define proper types/interfaces
- Avoid `any` type when possible

### React

- Use functional components with hooks
- Follow the existing component patterns
- Keep components focused and small

### Styling

- Use Tailwind CSS for styling
- Follow the existing design patterns
- Use Shadcn/UI components when applicable

### Commits

- Use clear, descriptive commit messages
- Reference issues in commits when applicable (e.g., `Fix #123`)
- Keep commits focused on a single change

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing!
