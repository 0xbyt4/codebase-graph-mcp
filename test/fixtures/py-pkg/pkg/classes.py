import pkg.other

class Base:
	def run(self):
		def nested():
			pass
		return nested

	async def stop(self):
		pass


class Child(Base):
  def run(self):
    pass
